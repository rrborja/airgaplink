import { AcousticFragmentReassembler, DEBUG_PROFILE, HANDSHAKE_CAPABILITY_COMPACT_READY, HANDSHAKE_CAPABILITY_OCTAL_CONTROL, HANDSHAKE_CAPABILITY_OCTAL_FSK, HANDSHAKE_CAPABILITY_QUAD_CONTROL, HANDSHAKE_CAPABILITY_QUAD_FSK, OpticalBlockEncryptor, aesGcmDecrypt, aesGcmEncrypt, canonicalTranscript, compactReadyNegotiated, decodeFskSamples, decodeOctalFskSamples, decodeOpticalCells, decodeQuadFskHandshakeSamples, decodeHandshakeResponse, decodeKeyConfirm, decodeReadyConfirm, deriveHandshakeMaterial, encodeFskPacket, encodeOctalFskHandshakePacket, encodeOpticalFrame, encodeQuadFskHandshakePacket, encodeHandshakeResponse, encodeKeyConfirmAudioMode, encodeReadyConfirm, encodeReadyConfirmCompact, fragmentHandshakeMessage, generateEphemeralKeyPair, keyConfirm, keyConfirmAudioMode, makeOffer, makeResponse, opticalNonce, readyConfirm, readyConfirmCompact, responseToneCount, runtimeToneAllowed, runtimeToneCount, signIdentity, verifyIdentity, verifyReadyConfirm, x25519SharedSecret, generateIdentityKeyPair, equalBytes } from './index.ts'
import { FastReadyAssembler, FSK_SYMBOL_SECONDS, HANDSHAKE_CAPABILITY_FAST_OCTAL, HANDSHAKE_CAPABILITY_FAST_READY, OCTAL_FAST_SYMBOL_SECONDS, encodeOctalFskPacket, fastReadyNegotiated, fastReadyPackets as makeFastReadyPackets, octalSymbolSeconds, readyConfirmFast, rotateHandshakePackets } from './index.ts'

const sender = generateEphemeralKeyPair(), receiver = generateEphemeralKeyPair(), another = generateEphemeralKeyPair()
const sharedSender = x25519SharedSecret(sender.privateKey, receiver.publicKey), sharedReceiver = x25519SharedSecret(receiver.privateKey, sender.publicKey)
if (!equalBytes(sharedSender, sharedReceiver)) throw new Error('X25519 peers did not agree')
if (equalBytes(sharedSender, x25519SharedSecret(sender.privateKey, another.publicKey))) throw new Error('Different X25519 peer unexpectedly agreed')

const offer = makeOffer(sender), response = makeResponse(offer, receiver, 1)
if (offer.capabilities & HANDSHAKE_CAPABILITY_QUAD_FSK || response.capabilities & HANDSHAKE_CAPABILITY_QUAD_FSK) throw new Error('Legacy offer unexpectedly negotiated four-tone audio')
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
const legacyDecoded = decodeFskSamples(encodeFskPacket(packets[0], 48000), 48000)
if (legacyDecoded.length !== 1 || legacyDecoded[0].sequence !== packets[0].sequence) throw new Error('Two-tone handshake fallback failed')
let rebuilt: Uint8Array | null = null
for (const [index, packet] of [...packets].reverse().entries()) { const item = reassembler.add(packet, 1_000 + index * 4_400); if (item) rebuilt = item.message }
if (!rebuilt || !equalBytes(rebuilt, message) || !decodeHandshakeResponse(rebuilt)) throw new Error('Shuffled acoustic fragments did not reassemble')
const positionLoss = new AcousticFragmentReassembler()
let positionRecovered: Uint8Array | null = null
for (let round = 0; round < 18 && !positionRecovered; round += 1) {
  const reordered = rotateHandshakePackets(fragmentHandshakeMessage(0x1234, 500 + round * packets.length, 0xaabbccdd, 1, message), round)
  for (const packet of reordered.slice(1)) {
    const complete = positionLoss.add(packet, 1_000 + round * 23_000)
    if (complete) positionRecovered = complete.message
  }
}
if (!positionRecovered || !equalBytes(positionRecovered, message)) throw new Error('Retry rotation did not recover a consistently lost first acoustic packet')
const fastOffer = makeOffer(sender, HANDSHAKE_CAPABILITY_QUAD_FSK), fastResponse = makeResponse(fastOffer, receiver, 1, fastOffer.capabilities & HANDSHAKE_CAPABILITY_QUAD_FSK)
if (fastResponse.capabilities !== HANDSHAKE_CAPABILITY_QUAD_FSK || deriveHandshakeMaterial(fastOffer, fastResponse, sender.privateKey).sas !== deriveHandshakeMaterial(fastOffer, fastResponse, receiver.privateKey, 'receiver').sas) throw new Error('Four-tone capability was not transcript-bound')
const runtimeOffer = makeOffer(sender, HANDSHAKE_CAPABILITY_QUAD_FSK | HANDSHAKE_CAPABILITY_QUAD_CONTROL)
const runtimeResponse = makeResponse(runtimeOffer, receiver, 1, runtimeOffer.capabilities & (HANDSHAKE_CAPABILITY_QUAD_FSK | HANDSHAKE_CAPABILITY_QUAD_CONTROL))
if (runtimeResponse.capabilities !== 6 || deriveHandshakeMaterial(runtimeOffer, runtimeResponse, sender.privateKey).sas !== deriveHandshakeMaterial(runtimeOffer, runtimeResponse, receiver.privateKey, 'receiver').sas) throw new Error('Runtime four-tone capability was not negotiated and transcript-bound')
const oldReceiverResponse = makeResponse(runtimeOffer, receiver, 1, runtimeOffer.capabilities & HANDSHAKE_CAPABILITY_QUAD_FSK)
if (oldReceiverResponse.capabilities & HANDSHAKE_CAPABILITY_QUAD_CONTROL) throw new Error('Older receiver incorrectly negotiated four-tone runtime ACK')
let unadvertisedAccepted = false
try { deriveHandshakeMaterial(fastOffer, makeResponse(fastOffer, receiver, 1, HANDSHAKE_CAPABILITY_QUAD_FSK | HANDSHAKE_CAPABILITY_QUAD_CONTROL), sender.privateKey); unadvertisedAccepted = true } catch { /* expected */ }
if (unadvertisedAccepted) throw new Error('Unadvertised runtime four-tone capability was accepted')
const octalOffer = makeOffer(sender, HANDSHAKE_CAPABILITY_QUAD_FSK | HANDSHAKE_CAPABILITY_QUAD_CONTROL | HANDSHAKE_CAPABILITY_OCTAL_FSK | HANDSHAKE_CAPABILITY_OCTAL_CONTROL | HANDSHAKE_CAPABILITY_COMPACT_READY)
const octalResponse = makeResponse(octalOffer, receiver, 1, octalOffer.capabilities)
if (!compactReadyNegotiated(octalOffer.capabilities, octalResponse.capabilities)) throw new Error('Both current peers failed to negotiate compact READY')
const fastOctalOffer = makeOffer(sender, octalOffer.capabilities | HANDSHAKE_CAPABILITY_FAST_OCTAL)
const fastOctalResponse = makeResponse(fastOctalOffer, receiver, 1, fastOctalOffer.capabilities)
if (octalSymbolSeconds(fastOctalOffer.capabilities, fastOctalResponse.capabilities) !== OCTAL_FAST_SYMBOL_SECONDS || octalSymbolSeconds(fastOctalOffer.capabilities, octalResponse.capabilities) !== FSK_SYMBOL_SECONDS || octalSymbolSeconds(octalOffer.capabilities, octalOffer.capabilities) !== FSK_SYMBOL_SECONDS) throw new Error('Fast eight-tone rate was not explicitly negotiated')
const fastOctalMaterial = deriveHandshakeMaterial(fastOctalOffer, fastOctalResponse, sender.privateKey)
if (!equalBytes(fastOctalMaterial.transcriptHash, deriveHandshakeMaterial(fastOctalOffer, fastOctalResponse, receiver.privateKey, 'receiver').transcriptHash)) throw new Error('Fast eight-tone capability changed the two peers’ transcript')
const tamperedFastCapabilities = { ...fastOctalResponse, capabilities: fastOctalResponse.capabilities & ~HANDSHAKE_CAPABILITY_FAST_OCTAL }
let acceptedRateDowngrade = false
try { deriveHandshakeMaterial(fastOctalOffer, tamperedFastCapabilities, sender.privateKey); acceptedRateDowngrade = true } catch { /* expected */ }
if (acceptedRateDowngrade) throw new Error('Acoustic rate downgrade escaped transcript authentication')
const oldEightToneCapabilities = HANDSHAKE_CAPABILITY_QUAD_FSK | HANDSHAKE_CAPABILITY_QUAD_CONTROL | HANDSHAKE_CAPABILITY_OCTAL_FSK | HANDSHAKE_CAPABILITY_OCTAL_CONTROL
const oldEightToneOffer = makeOffer(sender, oldEightToneCapabilities), oldEightToneResponse = makeResponse(oldEightToneOffer, receiver, 1, oldEightToneCapabilities)
const oldReceiverCapabilities = octalOffer.capabilities & ~HANDSHAKE_CAPABILITY_COMPACT_READY
if (compactReadyNegotiated(oldEightToneOffer.capabilities, oldEightToneResponse.capabilities) || compactReadyNegotiated(octalOffer.capabilities, oldReceiverCapabilities)) throw new Error('Compact READY was inferred from eight-tone capability alone')
const oldEightToneMaterial = deriveHandshakeMaterial(oldEightToneOffer, oldEightToneResponse, sender.privateKey)
const oldEightToneReady = decodeReadyConfirm(encodeReadyConfirm(oldEightToneOffer.sessionId, readyConfirm(oldEightToneMaterial.keys.handshakeConfirmKey, oldEightToneMaterial.transcriptHash)))
if (!oldEightToneReady || oldEightToneReady.compact || !verifyReadyConfirm(oldEightToneOffer.sessionId, oldEightToneMaterial.keys.handshakeConfirmKey, oldEightToneMaterial.transcriptHash, oldEightToneReady)) throw new Error('Older eight-tone peer cannot establish with full READY')
const newSenderOldReceiver = makeResponse(octalOffer, receiver, 1, oldReceiverCapabilities)
const newSenderOldReceiverMaterial = deriveHandshakeMaterial(octalOffer, newSenderOldReceiver, sender.privateKey)
const newSenderOldReceiverReady = decodeReadyConfirm(encodeReadyConfirm(octalOffer.sessionId, readyConfirm(newSenderOldReceiverMaterial.keys.handshakeConfirmKey, newSenderOldReceiverMaterial.transcriptHash)))
if (!newSenderOldReceiverReady || newSenderOldReceiverReady.compact || !verifyReadyConfirm(octalOffer.sessionId, newSenderOldReceiverMaterial.keys.handshakeConfirmKey, newSenderOldReceiverMaterial.transcriptHash, newSenderOldReceiverReady)) throw new Error('New sender rejected full READY from older eight-tone receiver')
if (responseToneCount(octalOffer.capabilities, 1) !== 8 || responseToneCount(octalOffer.capabilities, 2) !== 8 || responseToneCount(octalOffer.capabilities, 100) !== 8 || responseToneCount(fastOffer.capabilities, 1) !== 4 || responseToneCount(fastOffer.capabilities, 2) !== 4 || responseToneCount(0, 100) !== 2) throw new Error('Negotiated tone count changed on retry')
if (runtimeToneCount(octalResponse.capabilities, 8) !== 8 || runtimeToneCount(oldReceiverResponse.capabilities, 8) !== 2 || runtimeToneAllowed(octalResponse.capabilities, 4) || runtimeToneAllowed(octalResponse.capabilities, 2) || !runtimeToneAllowed(octalResponse.capabilities, 8) || runtimeToneAllowed(fastResponse.capabilities, 8)) throw new Error('Eight-tone session was not locked through runtime control')
let downgradedEightTone = false
try { runtimeToneCount(octalResponse.capabilities, 4); downgradedEightTone = true } catch { /* expected */ }
if (downgradedEightTone) throw new Error('Eight-tone session silently downgraded')
const octalMaterial = deriveHandshakeMaterial(octalOffer, octalResponse, sender.privateKey)
if (!equalBytes(octalMaterial.keys.opticalEncryptionKey, deriveHandshakeMaterial(octalOffer, octalResponse, receiver.privateKey, 'receiver').keys.opticalEncryptionKey)) throw new Error('Eight-tone negotiation changed session keys')
const octalMessage = encodeHandshakeResponse(octalResponse), octalPackets = fragmentHandshakeMessage(0x1234, 200, 0xaabbccdd, 1, octalMessage), octalAssembly = new AcousticFragmentReassembler()
let octalRebuilt: Uint8Array | null = null
for (const packet of octalPackets) {
  const decoded = decodeOctalFskSamples(encodeOctalFskHandshakePacket(packet, 48000), 48000)
  if (decoded.length !== 1) throw new Error('Eight-tone fragmented response failed acoustic decode')
  const result = octalAssembly.add(decoded[0])
  if (result) octalRebuilt = result.message
}
if (!octalRebuilt || !equalBytes(octalRebuilt, octalMessage)) throw new Error('Eight-tone response did not reassemble')
const octalRetryAssembly = new AcousticFragmentReassembler()
let octalRetryRebuilt: Uint8Array | null = null
for (const [index, packet] of octalPackets.entries()) if (index !== 3 && index !== 11) octalRetryAssembly.add(decodeOctalFskSamples(encodeOctalFskHandshakePacket(packet, 48000), 48000)[0], 1_000 + index * 1_300)
const octalRetryPackets = fragmentHandshakeMessage(0x1234, 300, 0xaabbccdd, 1, octalMessage)
for (const [index, packet] of octalRetryPackets.entries()) {
  if (responseToneCount(octalOffer.capabilities, 2) !== 8) throw new Error('Eight-tone retry changed physical mode')
  const decoded = decodeOctalFskSamples(encodeOctalFskHandshakePacket(packet, 48000), 48000)
  if (decoded.length !== 1) throw new Error('Eight-tone retry packet failed')
  const result = octalRetryAssembly.add(decoded[0], 25_000 + index * 1_300)
  if (result) octalRetryRebuilt = result.message
}
if (!octalRetryRebuilt || !equalBytes(octalRetryRebuilt, octalMessage)) throw new Error('Missing response fragments were not repaired by an eight-tone retry')
const octalResponseSeconds = octalPackets.reduce((seconds, packet) => seconds + encodeOctalFskHandshakePacket(packet, 48000).length / 48000 + 0.015, 0)
if (octalResponseSeconds >= 25) throw new Error('Eight-tone response duration did not improve enough')
const fastOctalPackets = fragmentHandshakeMessage(0x1234, 200, 0xaabbccdd, 1, encodeHandshakeResponse(fastOctalResponse))
const fastOctalAssembly = new AcousticFragmentReassembler()
let fastOctalRebuilt: Uint8Array | null = null
for (const packet of fastOctalPackets) {
  const decoded = decodeOctalFskSamples(encodeOctalFskHandshakePacket(packet, 48000, OCTAL_FAST_SYMBOL_SECONDS), 48000, OCTAL_FAST_SYMBOL_SECONDS)
  if (decoded.length !== 1) throw new Error('Fast eight-tone response fragment failed acoustic decode')
  const result = fastOctalAssembly.add(decoded[0])
  if (result) fastOctalRebuilt = result.message
}
if (!fastOctalRebuilt || !equalBytes(fastOctalRebuilt, encodeHandshakeResponse(fastOctalResponse))) throw new Error('Fast eight-tone response did not reassemble')
const fastOctalResponseSeconds = fastOctalPackets.reduce((seconds, packet) => seconds + encodeOctalFskHandshakePacket(packet, 48000, OCTAL_FAST_SYMBOL_SECONDS).length / 48000 + 0.015, 0)
if (fastOctalResponseSeconds >= octalResponseSeconds * 0.8) throw new Error('Fast eight-tone response airtime did not improve')
const octalReadyMessage = encodeReadyConfirmCompact(octalOffer.sessionId, readyConfirmCompact(octalMaterial.keys.handshakeConfirmKey, octalMaterial.transcriptHash))
const octalReadyPackets = fragmentHandshakeMessage(0x1234, 250, 0xaabbccdd, 2, octalReadyMessage)
const octalReadySeconds = octalReadyPackets.reduce((seconds, packet) => seconds + encodeOctalFskHandshakePacket(packet, 48000).length / 48000 + 0.015, 0)
if (octalReadyPackets.length !== 4 || octalReadySeconds >= 5.5) throw new Error('Eight-tone READY duration regressed')
const singleReadyOffer = makeOffer(sender, octalOffer.capabilities | HANDSHAKE_CAPABILITY_FAST_READY)
const singleReadyResponse = makeResponse(singleReadyOffer, receiver, 1, singleReadyOffer.capabilities)
if (!fastReadyNegotiated(singleReadyOffer.capabilities, singleReadyResponse.capabilities) || fastReadyNegotiated(singleReadyOffer.capabilities, octalResponse.capabilities)) throw new Error('Fast READY was not explicitly negotiated')
const singleReadySender = deriveHandshakeMaterial(singleReadyOffer, singleReadyResponse, sender.privateKey)
const singleReadyReceiver = deriveHandshakeMaterial(singleReadyOffer, singleReadyResponse, receiver.privateKey, 'receiver')
const singleReadyMac = readyConfirmFast(singleReadySender.keys.handshakeConfirmKey, singleReadySender.transcriptHash)
if (singleReadyMac.length !== 16 || !equalBytes(singleReadyMac, readyConfirmFast(singleReadyReceiver.keys.handshakeConfirmKey, singleReadyReceiver.transcriptHash))) throw new Error('Fast READY full-length MAC did not match')
if (equalBytes(singleReadyMac, readyConfirmFast(singleReadySender.keys.handshakeConfirmKey, octalMaterial.transcriptHash)) || equalBytes(singleReadyMac, readyConfirmFast(octalMaterial.keys.handshakeConfirmKey, singleReadySender.transcriptHash))) throw new Error('Fast READY was not bound to key and transcript')
const readyControl = makeFastReadyPackets(0x12345678, 410, singleReadyMac)
if (readyControl.length !== 2 || readyControl[0].payload.length !== 9 || readyControl[1].payload.length !== 9) throw new Error('Fast READY packet layout changed')
const decodedReadyControl = readyControl.map(packet => {
  const decoded = decodeOctalFskSamples(encodeOctalFskPacket(packet, 48000), 48000)
  if (decoded.length !== 1) throw new Error('Fast READY failed eight-tone acoustic decode')
  return decoded[0]
})
const singleReadyAssembly = new FastReadyAssembler()
if (singleReadyAssembly.add(decodedReadyControl[1], 0x12345678, 1_000) || singleReadyAssembly.add(decodedReadyControl[1], 0x12345678, 1_100)) throw new Error('Duplicate READY half established a session')
const assembledReadyMac = singleReadyAssembly.add(decodedReadyControl[0], 0x12345678, 1_200)
if (!assembledReadyMac || !equalBytes(assembledReadyMac, singleReadyMac)) throw new Error('Shuffled fast READY did not reassemble')
const mixedReady = new FastReadyAssembler()
mixedReady.add(decodedReadyControl[0], 0x12345678, 1_000)
if (mixedReady.add({ ...decodedReadyControl[1], transferId: 0x87654321 }, 0x12345678, 1_100)) throw new Error('Mixed-session READY packets were accepted')
const modifiedReady = { ...decodedReadyControl[1], payload: decodedReadyControl[1].payload.slice() }; modifiedReady.payload[8] ^= 1
const modifiedAssembly = new FastReadyAssembler()
modifiedAssembly.add(decodedReadyControl[0], 0x12345678, 1_000)
const modifiedMac = modifiedAssembly.add(modifiedReady, 0x12345678, 1_100)
if (!modifiedMac || equalBytes(modifiedMac, singleReadyMac)) throw new Error('Modified fast READY authenticated')
const expiredAssembly = new FastReadyAssembler()
expiredAssembly.add(decodedReadyControl[0], 0x12345678, 1_000)
if (expiredAssembly.add(decodedReadyControl[1], 0x12345678, 32_000)) throw new Error('Expired READY half was reused')
const twoPartReadySeconds = readyControl.reduce((seconds, packet) => seconds + encodeOctalFskPacket(packet, 48000).length / 48000 + 0.015, 0)
if (twoPartReadySeconds >= 3 || twoPartReadySeconds >= octalReadySeconds) throw new Error('Two-part authenticated READY did not shorten audio')
const fastOctalReadySeconds = readyControl.reduce((seconds, packet) => seconds + encodeOctalFskPacket(packet, 48000, OCTAL_FAST_SYMBOL_SECONDS).length / 48000 + 0.015, 0)
if (fastOctalReadySeconds >= twoPartReadySeconds * 0.8 || readyControl.some(packet => decodeOctalFskSamples(encodeOctalFskPacket(packet, 48000, OCTAL_FAST_SYMBOL_SECONDS), 48000, OCTAL_FAST_SYMBOL_SECONDS).length !== 1)) throw new Error('Fast eight-tone READY regressed')
const audioConfirmation = encodeKeyConfirmAudioMode(octalOffer.sessionId, 8, keyConfirmAudioMode(octalMaterial.keys.handshakeConfirmKey, octalMaterial.transcriptHash, 8))
const opticalConfirmationFrame = decodeOpticalCells(encodeOpticalFrame(audioConfirmation, 1, 0, DEBUG_PROFILE).cells, DEBUG_PROFILE)
if (!opticalConfirmationFrame.ok || !equalBytes(opticalConfirmationFrame.payload, audioConfirmation)) throw new Error('Eight-tone key confirmation failed optical transport')
const decodedAudioConfirmation = decodeKeyConfirm(opticalConfirmationFrame.payload)
if (!decodedAudioConfirmation || decodedAudioConfirmation.toneCount !== 8 || !equalBytes(decodedAudioConfirmation.confirmation, keyConfirmAudioMode(octalMaterial.keys.handshakeConfirmKey, octalMaterial.transcriptHash, 8))) throw new Error('Authenticated optical audio-mode selection failed')
const octalReadyAssembly = new AcousticFragmentReassembler()
let octalReadyRebuilt: Uint8Array | null = null
for (const packet of octalReadyPackets) {
  const decoded = decodeOctalFskSamples(encodeOctalFskHandshakePacket(packet, 48000), 48000)
  if (decoded.length !== 1) throw new Error('Eight-tone READY packet failed acoustic decode')
  const result = octalReadyAssembly.add(decoded[0])
  if (result) octalReadyRebuilt = result.message
}
const establishedReady = octalReadyRebuilt ? decodeReadyConfirm(octalReadyRebuilt) : null
if (!establishedReady?.compact || !verifyReadyConfirm(octalOffer.sessionId, octalMaterial.keys.handshakeConfirmKey, octalMaterial.transcriptHash, establishedReady)) throw new Error('Eight-tone READY did not establish the session')
const tamperedReady = octalReadyMessage.slice(); tamperedReady[23] ^= 1
if (verifyReadyConfirm(octalOffer.sessionId, octalMaterial.keys.handshakeConfirmKey, octalMaterial.transcriptHash, decodeReadyConfirm(tamperedReady))) throw new Error('Modified compact READY authenticated')
if (verifyReadyConfirm(differentSessionOffer.sessionId, octalMaterial.keys.handshakeConfirmKey, octalMaterial.transcriptHash, establishedReady)) throw new Error('Compact READY accepted another session')
if (verifyReadyConfirm(octalOffer.sessionId, senderMaterial.keys.handshakeConfirmKey, octalMaterial.transcriptHash, establishedReady) || verifyReadyConfirm(octalOffer.sessionId, octalMaterial.keys.handshakeConfirmKey, senderMaterial.transcriptHash, establishedReady)) throw new Error('Compact READY accepted another key or transcript')
const tamperedAudioConfirmation = audioConfirmation.slice(); tamperedAudioConfirmation[20] = 4
const tamperedAudio = decodeKeyConfirm(tamperedAudioConfirmation)
if (!tamperedAudio || equalBytes(tamperedAudio.confirmation, keyConfirmAudioMode(octalMaterial.keys.handshakeConfirmKey, octalMaterial.transcriptHash, tamperedAudio.toneCount!))) throw new Error('Modified audio-mode selection authenticated')
const fastMessage = encodeHandshakeResponse(fastResponse), fastPackets = fragmentHandshakeMessage(0x1234, 30, 0xaabbccdd, 1, fastMessage), fastAssembly = new AcousticFragmentReassembler()
let fastRebuilt: Uint8Array | null = null
for (const packet of fastPackets) {
  const sound = encodeQuadFskHandshakePacket(packet, 48000)
  const decoded = decodeQuadFskHandshakeSamples(sound, 48000)
  if (decoded.length !== 1) throw new Error('Four-tone fragmented response failed acoustic decode')
  const result = fastAssembly.add(decoded[0])
  if (result) fastRebuilt = result.message
}
if (!fastRebuilt || !equalBytes(fastRebuilt, fastMessage)) throw new Error('Four-tone fragmented response failed reassembly')
const readyMessage = encodeReadyConfirm(fastOffer.sessionId, readyConfirm(deriveHandshakeMaterial(fastOffer, fastResponse, sender.privateKey).keys.handshakeConfirmKey, deriveHandshakeMaterial(fastOffer, fastResponse, sender.privateKey).transcriptHash))
if (!verifyReadyConfirm(fastOffer.sessionId, deriveHandshakeMaterial(fastOffer, fastResponse, sender.privateKey).keys.handshakeConfirmKey, deriveHandshakeMaterial(fastOffer, fastResponse, sender.privateKey).transcriptHash, decodeReadyConfirm(readyMessage))) throw new Error('Legacy full-length READY verification regressed')
const fastReadyPackets = fragmentHandshakeMessage(0x1234, 60, 0xaabbccdd, 2, readyMessage)
const fastResponseSeconds = fastPackets.reduce((seconds, packet) => seconds + encodeQuadFskHandshakePacket(packet, 48000).length / 48000 + 0.015, 0)
const fastReadySeconds = fastReadyPackets.reduce((seconds, packet) => seconds + encodeQuadFskHandshakePacket(packet, 48000).length / 48000 + 0.015, 0)
if (octalResponseSeconds >= fastResponseSeconds * 0.72) throw new Error('Eight-tone response did not materially improve on four-tone audio')
if (fastPackets.length !== 18 || fastReadyPackets.length !== 9 || fastResponseSeconds + fastReadySeconds > 55) throw new Error('Four-tone handshake duration regressed')
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
console.log(JSON.stringify({ result: 'ok', fragments: packets.length, sas: senderMaterial.sas, fourToneResponseSeconds: Number(fastResponseSeconds.toFixed(2)), fourToneReadySeconds: Number(fastReadySeconds.toFixed(2)), eightToneResponseSeconds: Number(octalResponseSeconds.toFixed(2)), fastEightToneResponseSeconds: Number(fastOctalResponseSeconds.toFixed(2)), eightToneReadySeconds: Number(octalReadySeconds.toFixed(2)), twoPartReadySeconds: Number(twoPartReadySeconds.toFixed(2)), fastTwoPartReadySeconds: Number(fastOctalReadySeconds.toFixed(2)) }))
