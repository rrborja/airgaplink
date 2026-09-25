import { ed25519, x25519 } from '@noble/curves/ed25519.js'
import { hmac } from '@noble/hashes/hmac.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js'

export const CRYPTO_PROTOCOL_VERSION = 1
export const SESSION_ID_BYTES = 16
export const NONCE_BYTES = 16
export const X25519_KEY_BYTES = 32
export const AES_GCM_NONCE_BYTES = 12

export interface EphemeralKeyPair { privateKey: Uint8Array; publicKey: Uint8Array }
export interface SessionKeys { opticalEncryptionKey: Uint8Array; handshakeConfirmKey: Uint8Array; sessionBindingKey: Uint8Array }

export function randomBytes(length: number) {
  if (!Number.isInteger(length) || length < 1) throw new Error('Invalid random byte length')
  const bytes = new Uint8Array(length)
  globalThis.crypto.getRandomValues(bytes)
  return bytes
}

export function generateEphemeralKeyPair(): EphemeralKeyPair {
  const privateKey = randomBytes(X25519_KEY_BYTES)
  return { privateKey, publicKey: x25519.getPublicKey(privateKey) }
}

export function x25519SharedSecret(privateKey: Uint8Array, publicKey: Uint8Array) {
  if (privateKey.length !== X25519_KEY_BYTES || publicKey.length !== X25519_KEY_BYTES) throw new Error('Invalid X25519 key length')
  const shared = x25519.getSharedSecret(privateKey, publicKey)
  // Low-order points must never turn into an all-zero session secret.
  if (shared.every(value => value === 0)) throw new Error('Invalid X25519 peer key')
  return shared
}

export function sha256Bytes(bytes: Uint8Array) { return sha256(bytes) }
export function hmacSha256(key: Uint8Array, ...parts: Uint8Array[]) { return hmac(sha256, key, concatBytes(...parts)) }

export function deriveSessionKeys(sharedSecret: Uint8Array, salt: Uint8Array) : SessionKeys {
  const material = hkdf(sha256, sharedSecret, salt, utf8ToBytes('airgaplink/session/v1'), 96)
  return { opticalEncryptionKey: material.slice(0, 32), handshakeConfirmKey: material.slice(32, 64), sessionBindingKey: material.slice(64, 96) }
}

export function generateIdentityKeyPair() {
  const privateKey = randomBytes(32)
  return { privateKey, publicKey: ed25519.getPublicKey(privateKey) }
}
export function signIdentity(privateKey: Uint8Array, transcriptHash: Uint8Array) { return ed25519.sign(transcriptHash, privateKey) }
export function verifyIdentity(publicKey: Uint8Array, transcriptHash: Uint8Array, signature: Uint8Array) {
  return publicKey.length === 32 && signature.length === 64 && ed25519.verify(signature, transcriptHash, publicKey)
}

/** A per-session counter makes AES-GCM IV reuse structurally impossible. */
export function opticalNonce(prefix: Uint8Array, frameId: number, shardIndex: number) {
  if (prefix.length !== 6 || !Number.isInteger(frameId) || frameId < 0 || !Number.isInteger(shardIndex) || shardIndex < 0 || shardIndex > 0xffff) throw new Error('Invalid optical nonce fields')
  const nonce = new Uint8Array(AES_GCM_NONCE_BYTES), view = new DataView(nonce.buffer)
  nonce.set(prefix); view.setUint32(6, frameId); view.setUint16(10, shardIndex)
  return nonce
}
/** AAD is public routing metadata, but it is bound to every encrypted block. */
export function opticalBlockAad(sessionId: Uint8Array, transferId: number, blockId: number) {
  if (sessionId.length !== SESSION_ID_BYTES) throw new Error('Invalid session ID')
  const bytes = new Uint8Array(1 + SESSION_ID_BYTES + 4 + 4 + 1), view = new DataView(bytes.buffer)
  bytes[0] = CRYPTO_PROTOCOL_VERSION; bytes.set(sessionId, 1); view.setUint32(17, transferId); view.setUint32(21, blockId); bytes[25] = 1 // encrypted FEC source block
  return bytes
}

export async function aesGcmEncrypt(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad: Uint8Array) {
  if (key.length !== 32 || nonce.length !== AES_GCM_NONCE_BYTES) throw new Error('Invalid AES-GCM key or nonce')
  const imported = await globalThis.crypto.subtle.importKey('raw', webBytes(key), 'AES-GCM', false, ['encrypt'])
  return new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv: webBytes(nonce), additionalData: webBytes(aad), tagLength: 128 }, imported, webBytes(plaintext)))
}
export async function aesGcmDecrypt(key: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array, aad: Uint8Array) {
  if (key.length !== 32 || nonce.length !== AES_GCM_NONCE_BYTES) throw new Error('Invalid AES-GCM key or nonce')
  const imported = await globalThis.crypto.subtle.importKey('raw', webBytes(key), 'AES-GCM', false, ['decrypt'])
  return new Uint8Array(await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv: webBytes(nonce), additionalData: webBytes(aad), tagLength: 128 }, imported, webBytes(ciphertext)))
}

/** Encrypt each logical block exactly once; optical repeats reuse its ciphertext. */
export class OpticalBlockEncryptor {
  private readonly ciphertext = new Map<number, Uint8Array>()
  private readonly pending = new Map<number, Promise<Uint8Array>>()
  private readonly usedIds = new Set<number>()
  private destroyed = false
  private readonly key: Uint8Array
  private readonly noncePrefix: Uint8Array
  private readonly sessionId: Uint8Array
  private readonly transferId: number
  constructor(key: Uint8Array, noncePrefix: Uint8Array, sessionId: Uint8Array, transferId: number) { this.key = key; this.noncePrefix = noncePrefix; this.sessionId = sessionId; this.transferId = transferId }
  encrypt(blockId: number, plaintext: Uint8Array): Promise<Uint8Array> {
    if (this.destroyed || !Number.isInteger(blockId) || blockId < 0 || blockId > 0xffffffff) throw new Error('Invalid encrypted block')
    const cached = this.ciphertext.get(blockId)
    if (cached) return Promise.resolve(cached)
    const inFlight = this.pending.get(blockId)
    if (inFlight) return inFlight
    if (this.usedIds.has(blockId)) throw new Error('AES-GCM nonce already used for this block')
    this.usedIds.add(blockId)
    const promise = aesGcmEncrypt(this.key, opticalNonce(this.noncePrefix, blockId, 0), plaintext, opticalBlockAad(this.sessionId, this.transferId, blockId))
      .then(bytes => { if (!this.destroyed) this.ciphertext.set(blockId, bytes); return bytes })
      .finally(() => this.pending.delete(blockId))
    this.pending.set(blockId, promise)
    return promise
  }
  /** Safe after a cumulative ACK: this block must never be encrypted again. */
  evict(blockId: number) { this.ciphertext.delete(blockId) }
  evictAcknowledged(acknowledged: ReadonlySet<number>, preserveBlockId?: number) { for (const blockId of this.ciphertext.keys()) if (blockId !== preserveBlockId && acknowledged.has(blockId)) this.ciphertext.delete(blockId) }
  clear() { this.destroyed = true; this.ciphertext.clear(); this.pending.clear() }
}

export function zeroBytes(bytes: Uint8Array | undefined) { if (bytes) bytes.fill(0) }
function webBytes(bytes: Uint8Array) { const copy = new Uint8Array(bytes.length); copy.set(bytes); return copy }
