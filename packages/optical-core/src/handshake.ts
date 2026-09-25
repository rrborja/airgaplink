import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { CRYPTO_PROTOCOL_VERSION, deriveSessionKeys, hmacSha256, NONCE_BYTES, randomBytes, SESSION_ID_BYTES, sha256Bytes, type EphemeralKeyPair, type SessionKeys, X25519_KEY_BYTES, x25519SharedSecret } from './crypto.ts'

export const HANDSHAKE_OFFER_MAGIC = Uint8Array.of(0x41, 0x48, 0x4f, 1) // AHO1
export const KEY_CONFIRM_MAGIC = Uint8Array.of(0x41, 0x48, 0x4b, 1) // AHK1
export const HANDSHAKE_RESPONSE_MAGIC = Uint8Array.of(0x41, 0x48, 0x52, 1) // AHR1
export const HANDSHAKE_READY_MAGIC = Uint8Array.of(0x41, 0x48, 0x59, 1) // AHY1
export const HANDSHAKE_CAPABILITY_IDENTITY = 1

export interface HandshakeOffer { protocolVersion: number; sessionId: Uint8Array; senderEphemeralPublicKey: Uint8Array; senderNonce: Uint8Array; capabilities: number }
export interface HandshakeResponse { protocolVersion: number; sessionId: Uint8Array; receiverEphemeralPublicKey: Uint8Array; receiverNonce: Uint8Array; profileId: number; capabilities: number; receiverIdentity?: Uint8Array; identitySignature?: Uint8Array; transcriptBinding: Uint8Array }
export interface HandshakeMaterial { transcript: Uint8Array; transcriptHash: Uint8Array; salt: Uint8Array; keys: SessionKeys; sas: string }

function check(bytes: Uint8Array, length: number, field: string) { if (bytes.length !== length) throw new Error(`Invalid ${field}`) }
function u32(value: number) { const bytes = new Uint8Array(4); new DataView(bytes.buffer).setUint32(0, value); return bytes }

/** Canonical fixed-width transcript; no JSON or ambiguous concatenation. */
export function canonicalTranscript(offer: HandshakeOffer, response: Pick<HandshakeResponse, 'receiverEphemeralPublicKey' | 'receiverNonce' | 'profileId' | 'capabilities'>) {
  check(offer.sessionId, SESSION_ID_BYTES, 'session ID'); check(offer.senderEphemeralPublicKey, X25519_KEY_BYTES, 'sender public key'); check(offer.senderNonce, NONCE_BYTES, 'sender nonce')
  check(response.receiverEphemeralPublicKey, X25519_KEY_BYTES, 'receiver public key'); check(response.receiverNonce, NONCE_BYTES, 'receiver nonce')
  if (offer.protocolVersion !== CRYPTO_PROTOCOL_VERSION) throw new Error('Unsupported handshake protocol')
  return concatBytes(utf8ToBytes('airgaplink/transcript/v1'), Uint8Array.of(offer.protocolVersion), offer.sessionId, offer.senderEphemeralPublicKey, response.receiverEphemeralPublicKey, offer.senderNonce, response.receiverNonce, Uint8Array.of(response.profileId), u32(offer.capabilities), u32(response.capabilities))
}
export function sessionSalt(offer: HandshakeOffer, receiverNonce: Uint8Array) { return sha256Bytes(concatBytes(Uint8Array.of(offer.protocolVersion), offer.sessionId, offer.senderNonce, receiverNonce)) }
export function deriveHandshakeMaterial(offer: HandshakeOffer, response: HandshakeResponse, privateKey: Uint8Array, role: 'sender' | 'receiver' = 'sender'): HandshakeMaterial {
  if (!equalBytes(offer.sessionId, response.sessionId) || response.protocolVersion !== offer.protocolVersion) throw new Error('Handshake session mismatch')
  const transcript = canonicalTranscript(offer, response), transcriptHash = sha256Bytes(transcript)
  const keys = deriveSessionKeys(x25519SharedSecret(privateKey, role === 'sender' ? response.receiverEphemeralPublicKey : offer.senderEphemeralPublicKey), sessionSalt(offer, response.receiverNonce))
  const expected = transcriptBinding(keys.sessionBindingKey, transcriptHash)
  if (!equalBytes(expected, response.transcriptBinding)) throw new Error('Handshake transcript binding failed')
  return { transcript, transcriptHash, salt: sessionSalt(offer, response.receiverNonce), keys, sas: sasCode(keys.sessionBindingKey, transcriptHash) }
}
export function makeOffer(sender: EphemeralKeyPair, capabilities = 0): HandshakeOffer { return { protocolVersion: CRYPTO_PROTOCOL_VERSION, sessionId: randomBytes(SESSION_ID_BYTES), senderEphemeralPublicKey: sender.publicKey, senderNonce: randomBytes(NONCE_BYTES), capabilities } }
export function makeResponse(offer: HandshakeOffer, receiver: EphemeralKeyPair, profileId: number, capabilities = 0, identity?: { publicKey: Uint8Array; signature: Uint8Array }): HandshakeResponse {
  const receiverNonce = randomBytes(NONCE_BYTES)
  const provisional = { protocolVersion: offer.protocolVersion, sessionId: offer.sessionId, receiverEphemeralPublicKey: receiver.publicKey, receiverNonce, profileId, capabilities }
  const transcriptHash = sha256Bytes(canonicalTranscript(offer, provisional))
  const keys = deriveSessionKeys(x25519SharedSecret(receiver.privateKey, offer.senderEphemeralPublicKey), sessionSalt(offer, receiverNonce))
  return { ...provisional, receiverIdentity: identity?.publicKey, identitySignature: identity?.signature, transcriptBinding: transcriptBinding(keys.sessionBindingKey, transcriptHash) }
}
export function transcriptBinding(key: Uint8Array, transcriptHash: Uint8Array) { return hmacSha256(key, utf8ToBytes('airgaplink/response/v1'), transcriptHash) }
export function sasCode(key: Uint8Array, transcriptHash: Uint8Array) {
  const value = new DataView(hmacSha256(key, utf8ToBytes('airgaplink/sas/v1'), transcriptHash).buffer).getUint32(0) % 1_000_000_000
  return `${Math.floor(value / 1_000_000).toString().padStart(3, '0')}-${(Math.floor(value / 1_000) % 1_000).toString().padStart(3, '0')}-${(value % 1_000).toString().padStart(3, '0')}`
}
export function keyConfirm(key: Uint8Array, transcriptHash: Uint8Array) { return hmacSha256(key, transcriptHash, utf8ToBytes('sender-confirm')) }
export function readyConfirm(key: Uint8Array, transcriptHash: Uint8Array) { return hmacSha256(key, transcriptHash, utf8ToBytes('receiver-ready')) }
export function equalBytes(left: Uint8Array, right: Uint8Array) { if (left.length !== right.length) return false; let different = 0; for (let i = 0; i < left.length; i += 1) different |= left[i] ^ right[i]; return different === 0 }

export function encodeHandshakeOffer(offer: HandshakeOffer) { check(offer.sessionId, 16, 'session ID'); check(offer.senderEphemeralPublicKey, 32, 'sender public key'); check(offer.senderNonce, 16, 'sender nonce'); return concatBytes(HANDSHAKE_OFFER_MAGIC, Uint8Array.of(offer.protocolVersion), offer.sessionId, offer.senderEphemeralPublicKey, offer.senderNonce, u32(offer.capabilities)) }
export function decodeHandshakeOffer(bytes: Uint8Array): HandshakeOffer | null { try { if (bytes.length !== 73 || !equalBytes(bytes.slice(0, 4), HANDSHAKE_OFFER_MAGIC)) return null; const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); return { protocolVersion: bytes[4], sessionId: bytes.slice(5, 21), senderEphemeralPublicKey: bytes.slice(21, 53), senderNonce: bytes.slice(53, 69), capabilities: view.getUint32(69) } } catch { return null } }
export function encodeKeyConfirm(sessionId: Uint8Array, confirmation: Uint8Array) { check(sessionId, 16, 'session ID'); check(confirmation, 32, 'confirmation'); return concatBytes(KEY_CONFIRM_MAGIC, sessionId, confirmation) }
export function decodeKeyConfirm(bytes: Uint8Array) { return bytes.length === 52 && equalBytes(bytes.slice(0, 4), KEY_CONFIRM_MAGIC) ? { sessionId: bytes.slice(4, 20), confirmation: bytes.slice(20) } : null }
export function encodeReadyConfirm(sessionId: Uint8Array, confirmation: Uint8Array) { check(sessionId, 16, 'session ID'); check(confirmation, 32, 'confirmation'); return concatBytes(HANDSHAKE_READY_MAGIC, sessionId, confirmation) }
export function decodeReadyConfirm(bytes: Uint8Array) { return bytes.length === 52 && equalBytes(bytes.slice(0, 4), HANDSHAKE_READY_MAGIC) ? { sessionId: bytes.slice(4, 20), confirmation: bytes.slice(20) } : null }
export function encodeHandshakeResponse(response: HandshakeResponse) {
  const identity = response.receiverIdentity || new Uint8Array(), signature = response.identitySignature || new Uint8Array()
  if ((identity.length !== 0 && identity.length !== 32) || (signature.length !== 0 && signature.length !== 64) || (identity.length === 0) !== (signature.length === 0)) throw new Error('Invalid identity response')
  check(response.sessionId, 16, 'session ID'); check(response.receiverEphemeralPublicKey, 32, 'receiver public key'); check(response.receiverNonce, 16, 'receiver nonce'); check(response.transcriptBinding, 32, 'transcript binding')
  return concatBytes(HANDSHAKE_RESPONSE_MAGIC, Uint8Array.of(response.protocolVersion), response.sessionId, response.receiverEphemeralPublicKey, response.receiverNonce, Uint8Array.of(response.profileId), u32(response.capabilities), Uint8Array.of(identity.length, signature.length), identity, signature, response.transcriptBinding)
}
export function decodeHandshakeResponse(bytes: Uint8Array): HandshakeResponse | null { try {
  if (bytes.length < 108 || !equalBytes(bytes.slice(0, 4), HANDSHAKE_RESPONSE_MAGIC)) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), identityLength = bytes[74], signatureLength = bytes[75], expected = 108 + identityLength + signatureLength
  if (bytes.length !== expected || !((identityLength === 0 && signatureLength === 0) || (identityLength === 32 && signatureLength === 64))) return null
  const identityStart = 76, signatureStart = identityStart + identityLength
  return { protocolVersion: bytes[4], sessionId: bytes.slice(5, 21), receiverEphemeralPublicKey: bytes.slice(21, 53), receiverNonce: bytes.slice(53, 69), profileId: bytes[69], capabilities: view.getUint32(70), receiverIdentity: identityLength ? bytes.slice(identityStart, signatureStart) : undefined, identitySignature: signatureLength ? bytes.slice(signatureStart, signatureStart + signatureLength) : undefined, transcriptBinding: bytes.slice(signatureStart + signatureLength) }
} catch { return null } }
