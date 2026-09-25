import { AcousticFragmentReassembler, OpticalBlockEncryptor, aesGcmDecrypt, aesGcmEncrypt, canonicalTranscript, decodeFskSamples, decodeHandshakeResponse, deriveHandshakeMaterial, encodeFskPacket, encodeHandshakeResponse, fragmentHandshakeMessage, generateEphemeralKeyPair, keyConfirm, makeOffer, makeResponse, opticalNonce, readyConfirm, signIdentity, verifyIdentity, x25519SharedSecret, generateIdentityKeyPair, equalBytes } from './index.ts'

const sender = generateEphemeralKeyPair(), receiver = generateEphemeralKeyPair(), another = generateEphemeralKeyPair()
const sharedSender = x25519SharedSecret(sender.privateKey, receiver.publicKey), sharedReceiver = x25519SharedSecret(receiver.privateKey, sender.publicKey)
if (!equalBytes(sharedSender, sharedReceiver)) throw new Error('X25519 peers did not agree')
if (equalBytes(sharedSender, x25519SharedSecret(sender.privateKey, another.publicKey))) throw new Error('Different X25519 peer unexpectedly agreed')

const offer = makeOffer(sender), response = makeResponse(offer, receiver, 1)
const senderMaterial = deriveHandshakeMaterial(offer, response, sender.privateKey)
const receiverMaterial = deriveHandshakeMaterial(offer, response, receiver.privateKey, 'receiver')
if (!equalBytes(senderMaterial.keys.opticalEncryptionKey, receiverMaterial.keys.opticalEncryptionKey) || senderMaterial.sas !== receiverMaterial.sas) throw new Error('Session derivation or SAS differs')
const alternateOffer = { ...offer, senderNonce: offer.senderNonce.slice() }; alternateOffer.senderNonce[0] ^= 1
const alternateResponse = makeResponse(alternateOffer, receiver, 1)
if (equalBytes(senderMaterial.keys.opticalEncryptionKey, deriveHandshakeMaterial(alternateOffer, alternateResponse, sender.privateKey).keys.opticalEncryptionKey)) throw new Error('Nonce did not bind HKDF')
const differentSessionOffer = { ...offer, sessionId: offer.sessionId.slice() }; differentSessionOffer.sessionId[0] ^= 1
const differentSessionResponse = makeResponse(differentSessionOffer, receiver, 1)
if (equalBytes(senderMaterial.keys.opticalEncryptionKey, deriveHandshakeMaterial(differentSessionOffer, differentSessionResponse, sender.privateKey).keys.opticalEncryptionKey)) throw new Error('Session ID did not bind HKDF')
const differentPeerResponse = makeResponse(offer, another, 1)
if (equalBytes(senderMaterial.keys.opticalEncryptionKey, deriveHandshakeMaterial(offer, differentPeerResponse, sender.privateKey).keys.opticalEncryptionKey)) throw new Error('Ephemeral public key did not bind HKDF')
if (equalBytes(canonicalTranscript(offer, response), canonicalTranscript(alternateOffer, alternateResponse))) throw new Error('Transcript is not deterministic/bound')

const message = encodeHandshakeResponse(response), packets = fragmentHandshakeMessage(0x1234, 6, 0xaabbccdd, 1, message), reassembler = new AcousticFragmentReassembler()
let rebuilt: Uint8Array | null = null
for (const [index, packet] of [...packets].reverse().entries()) { const item = reassembler.add(packet, 1_000 + index * 4_400); if (item) rebuilt = item.message }
if (!rebuilt || !equalBytes(rebuilt, message) || !decodeHandshakeResponse(rebuilt)) throw new Error('Shuffled acoustic fragments did not reassemble')
const duplicates = new AcousticFragmentReassembler(); for (const packet of packets) { duplicates.add(packet); duplicates.add(packet) }
const mixed = new AcousticFragmentReassembler(); for (const packet of packets.slice(0, -1)) mixed.add(packet); const foreign = packets.at(-1)!; foreign.payload[0] ^= 1; if (mixed.add(foreign)) throw new Error('Mixed session fragments combined')
const retryAssembly = new AcousticFragmentReassembler()
let retried: Uint8Array | null = null
for (const [index, packet] of packets.entries()) if (index !== 3 && index !== 11) retryAssembly.add(packet, 1_000 + index * 4_400)
const retryPackets = fragmentHandshakeMessage(0x1234, 100, 0xaabbccdd, 1, message)
for (const [index, packet] of retryPackets.entries()) { const result = retryAssembly.add(packet, 85_000 + index * 4_400); if (result) retried = result.message }
if (!retried || !equalBytes(retried, message)) throw new Error('Missing acoustic fragments did not recover on retransmission')
const corruptedSound = encodeFskPacket(packets[0], 48000); corruptedSound.fill(0, Math.floor(corruptedSound.length / 3), Math.floor(corruptedSound.length * 2 / 3)); if (decodeFskSamples(corruptedSound, 48000).length) throw new Error('Corrupted handshake fragment passed CRC')

const confirm = keyConfirm(senderMaterial.keys.handshakeConfirmKey, senderMaterial.transcriptHash)
if (!equalBytes(confirm, keyConfirm(receiverMaterial.keys.handshakeConfirmKey, receiverMaterial.transcriptHash)) || equalBytes(confirm, readyConfirm(senderMaterial.keys.handshakeConfirmKey, senderMaterial.transcriptHash))) throw new Error('Key confirmation is not bound')
const aad = senderMaterial.transcriptHash, nonce = opticalNonce(senderMaterial.keys.sessionBindingKey.slice(0, 6), 42, 3), plaintext = Uint8Array.of(1, 2, 3, 4)
const encrypted = await aesGcmEncrypt(senderMaterial.keys.opticalEncryptionKey, nonce, plaintext, aad)
const decrypted = await aesGcmDecrypt(senderMaterial.keys.opticalEncryptionKey, nonce, encrypted, aad)
if (!equalBytes(decrypted, plaintext) || equalBytes(nonce, opticalNonce(senderMaterial.keys.sessionBindingKey.slice(0, 6), 43, 3))) throw new Error('AES-GCM roundtrip or nonce uniqueness failed')
encrypted[0] ^= 1
let authenticated = false; try { await aesGcmDecrypt(senderMaterial.keys.opticalEncryptionKey, nonce, encrypted, aad); authenticated = true } catch { /* expected */ }
if (authenticated) throw new Error('Modified AES-GCM ciphertext authenticated')
const blockEncryptor = new OpticalBlockEncryptor(senderMaterial.keys.opticalEncryptionKey, senderMaterial.keys.sessionBindingKey.slice(0, 6), offer.sessionId, 0x1234)
const [firstCiphertext, repeatedCiphertext] = await Promise.all([blockEncryptor.encrypt(0, plaintext), blockEncryptor.encrypt(0, plaintext)])
if (firstCiphertext !== repeatedCiphertext || (await blockEncryptor.encrypt(0, plaintext)) !== firstCiphertext) throw new Error('Repeated block caused a second AES-GCM encryption')
blockEncryptor.evictAcknowledged(new Set([0]), 0)
if ((await blockEncryptor.encrypt(0, plaintext)) !== firstCiphertext) throw new Error('Alignment block was evicted before calibration completed')
blockEncryptor.evictAcknowledged(new Set([0]))
let nonceReused = false; try { await blockEncryptor.encrypt(0, plaintext); nonceReused = true } catch { /* expected */ }
if (nonceReused) throw new Error('Evicted block reused its AES-GCM nonce')
if (equalBytes(firstCiphertext, await blockEncryptor.encrypt(1, plaintext))) throw new Error('Distinct block IDs reused ciphertext')

const attackerForSender = generateEphemeralKeyPair(), attackerForReceiver = generateEphemeralKeyPair()
const attackerResponse = makeResponse(offer, attackerForSender, 1)
const senderSas = deriveHandshakeMaterial(offer, attackerResponse, sender.privateKey).sas
const receiverSideOffer = { ...offer, senderEphemeralPublicKey: attackerForReceiver.publicKey }
const receiverSideResponse = makeResponse(receiverSideOffer, receiver, 1)
const receiverSas = deriveHandshakeMaterial(receiverSideOffer, receiverSideResponse, receiver.privateKey, 'receiver').sas
if (senderSas === receiverSas) throw new Error('MITM substitution did not alter SAS')
const identity = generateIdentityKeyPair(), signature = signIdentity(identity.privateKey, senderMaterial.transcriptHash)
if (!verifyIdentity(identity.publicKey, senderMaterial.transcriptHash, signature) || verifyIdentity(another.publicKey, senderMaterial.transcriptHash, signature)) throw new Error('Persistent identity substitution was not rejected')
console.log(JSON.stringify({ result: 'ok', fragments: packets.length, sas: senderMaterial.sas }))
