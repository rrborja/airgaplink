import { CONTROL_MAX_PAYLOAD, ControlType, type ControlPacket } from './control.ts'
import type { ReedSolomonBlockCodec } from './fec.ts'
import { equalBytes, HANDSHAKE_NACK_DENSE, HANDSHAKE_NACK_LEGACY, type HandshakeNack } from './handshake.ts'

export const HANDSHAKE_FRAGMENT_DATA_BYTES = 6
export const MAX_HANDSHAKE_FRAGMENTS = 64
export const MAX_HANDSHAKE_MESSAGE_BYTES = Math.min(255, MAX_HANDSHAKE_FRAGMENTS * HANDSHAKE_FRAGMENT_DATA_BYTES)
export const DENSE_HANDSHAKE_DATA_BYTES = 9
export const DENSE_HANDSHAKE_PARITY_FRAGMENTS = 2
export const MAX_DENSE_HANDSHAKE_FRAGMENTS = 31
export interface AcousticFragment { sessionTag: number; messageType: number; index: number; count: number; data: Uint8Array }

/** The physical transfer ID contains sessionId[0..3]. The next byte-sized
 * discriminator is only for fragment routing; the full session ID and HMAC
 * in the assembled response remain the authentication boundary. */
export function denseHandshakeSessionTag(sessionId: Uint8Array) {
  if (sessionId.length !== 16) throw new Error('Invalid dense handshake session ID')
  let tag = 0
  for (let index = 4; index < sessionId.length; index += 1) tag ^= sessionId[index]
  return tag
}

/** Payload [sessionTag8, parityFlag:1|index:5, totalLength8, shard:9].
 * ControlType identifies this as a response fragment, avoiding the legacy
 * six-byte fragment header. All shards are padded to nine bytes for FEC. */
export function fragmentDenseHandshakeResponse(transferId: number, sequenceStart: number, sessionId: Uint8Array, message: Uint8Array, parityCodec?: ReedSolomonBlockCodec): ControlPacket[] {
  if (message.length < 1 || message.length > 255) throw new Error('Invalid dense handshake message length')
  const dataCount = Math.ceil(message.length / DENSE_HANDSHAKE_DATA_BYTES)
  const parityCount = parityCodec ? DENSE_HANDSHAKE_PARITY_FRAGMENTS : 0
  if (dataCount + parityCount > MAX_DENSE_HANDSHAKE_FRAGMENTS) throw new Error('Too many dense handshake fragments')
  const tag = denseHandshakeSessionTag(sessionId)
  const shards = parityCodec
    ? parityCodec.encode(message, DENSE_HANDSHAKE_DATA_BYTES, dataCount, parityCount).symbols
    : Array.from({ length: dataCount }, (_, index) => { const shard = new Uint8Array(DENSE_HANDSHAKE_DATA_BYTES); shard.set(message.subarray(index * DENSE_HANDSHAKE_DATA_BYTES, (index + 1) * DENSE_HANDSHAKE_DATA_BYTES)); return shard })
  return shards.map((shard, index) => {
    const payload = new Uint8Array(CONTROL_MAX_PAYLOAD)
    payload[0] = tag; payload[1] = index | (parityCount ? 0x20 : 0); payload[2] = message.length; payload.set(shard, 3)
    return { type: ControlType.HANDSHAKE_DENSE_FRAGMENT, transferId, sequence: (sequenceStart + index) & 0xffff, payload }
  })
}

export interface DenseHandshakeFragment { sessionTag: number; index: number; dataCount: number; parityCount: number; totalLength: number; data: Uint8Array }
export function parseDenseHandshakeFragment(packet: ControlPacket): DenseHandshakeFragment | null {
  if (packet.type !== ControlType.HANDSHAKE_DENSE_FRAGMENT || packet.payload.length !== CONTROL_MAX_PAYLOAD || packet.payload[1] & 0xc0) return null
  const totalLength = packet.payload[2], dataCount = Math.ceil(totalLength / DENSE_HANDSHAKE_DATA_BYTES)
  const parityCount = packet.payload[1] & 0x20 ? DENSE_HANDSHAKE_PARITY_FRAGMENTS : 0
  const index = packet.payload[1] & 0x1f
  if (!totalLength || dataCount + parityCount > MAX_DENSE_HANDSHAKE_FRAGMENTS || index >= dataCount + parityCount) return null
  return { sessionTag: packet.payload[0], index, dataCount, parityCount, totalLength, data: packet.payload.slice(3) }
}

export class DenseHandshakeReassembler {
  private readonly transferId: number
  private readonly sessionTag: number
  private readonly codecFactory?: () => ReedSolomonBlockCodec
  private readonly expiryMs: number
  private readonly assemblies = new Map<string, { createdAt: number; fragment: DenseHandshakeFragment; pieces: Map<number, Uint8Array> }>()
  constructor(sessionId: Uint8Array, codecFactory?: () => ReedSolomonBlockCodec, expiryMs = 60_000) {
    this.sessionTag = denseHandshakeSessionTag(sessionId)
    this.transferId = new DataView(sessionId.buffer, sessionId.byteOffset, 4).getUint32(0)
    this.codecFactory = codecFactory
    this.expiryMs = expiryMs
  }
  clear() { this.assemblies.clear() }
  add(packet: ControlPacket, now = Date.now()): { message: Uint8Array; recovered: number } | null {
    this.expire(now)
    const fragment = parseDenseHandshakeFragment(packet)
    if (!fragment || packet.transferId !== this.transferId || fragment.sessionTag !== this.sessionTag) return null
    const key = `${fragment.totalLength}:${fragment.parityCount}`
    let assembly = this.assemblies.get(key)
    if (!assembly) {
      if (this.assemblies.size >= 2) this.assemblies.delete(this.assemblies.keys().next().value!)
      assembly = { createdAt: now, fragment, pieces: new Map() }; this.assemblies.set(key, assembly)
    }
    const existing = assembly.pieces.get(fragment.index)
    if (existing) {
      if (!existing.every((value, index) => value === fragment.data[index])) return null
    } else assembly.pieces.set(fragment.index, fragment.data)
    const missing = this.missingFor(assembly)
    let message: Uint8Array | null = null
    if (!missing.length) {
      message = new Uint8Array(fragment.dataCount * DENSE_HANDSHAKE_DATA_BYTES)
      for (let index = 0; index < fragment.dataCount; index += 1) message.set(assembly.pieces.get(index)!, index * DENSE_HANDSHAKE_DATA_BYTES)
      message = message.slice(0, fragment.totalLength)
    } else if (fragment.parityCount && missing.length <= fragment.parityCount && assembly.pieces.size >= fragment.dataCount && this.codecFactory) {
      try {
        message = this.codecFactory().recover([...assembly.pieces].map(([index, bytes]) => ({ index, bytes })), fragment.dataCount, fragment.parityCount, DENSE_HANDSHAKE_DATA_BYTES, fragment.totalLength)
      } catch { /* Wait for a valid retransmission instead. */ }
    }
    if (!message) return null
    this.assemblies.delete(key)
    return { message, recovered: missing.length }
  }
  progress(now = Date.now()) {
    this.expire(now)
    const assembly = [...this.assemblies.values()].sort((left, right) => right.pieces.size - left.pieces.size)[0]
    if (!assembly) return null
    const { dataCount, parityCount, totalLength } = assembly.fragment
    return { dataCount, parityCount, totalLength, received: assembly.pieces.size, missing: this.missingFor(assembly) }
  }
  private missingFor(assembly: { fragment: DenseHandshakeFragment; pieces: Map<number, Uint8Array> }) {
    return Array.from({ length: assembly.fragment.dataCount }, (_, index) => index).filter(index => !assembly.pieces.has(index))
  }
  private expire(now: number) { for (const [key, value] of this.assemblies) if (now - value.createdAt > this.expiryMs) this.assemblies.delete(key) }
}

/** The normal packet remains 12 bytes. Fragment payload is [tag16,type,index,count,total,data≤6].
 * The physical packet transferId is also part of the assembly discriminator. */
export function fragmentHandshakeMessage(transferId: number, sequenceStart: number, sessionTag: number, messageType: number, message: Uint8Array): ControlPacket[] {
  if (message.length < 1 || message.length > MAX_HANDSHAKE_MESSAGE_BYTES) throw new Error('Invalid handshake message length')
  const count = Math.ceil(message.length / HANDSHAKE_FRAGMENT_DATA_BYTES)
  return Array.from({ length: count }, (_, index) => {
    const payload = new Uint8Array(6 + Math.min(HANDSHAKE_FRAGMENT_DATA_BYTES, message.length - index * HANDSHAKE_FRAGMENT_DATA_BYTES)), view = new DataView(payload.buffer)
    view.setUint16(0, sessionTag & 0xffff); payload[2] = messageType; payload[3] = index; payload[4] = count; payload[5] = message.length
    payload.set(message.slice(index * HANDSHAKE_FRAGMENT_DATA_BYTES, (index + 1) * HANDSHAKE_FRAGMENT_DATA_BYTES), 6)
    return { type: ControlType.HANDSHAKE_FRAGMENT, transferId, sequence: (sequenceStart + index) & 0xffff, payload }
  })
}
/** Change the on-air position of every fragment on retry. A speaker/mic path
 * that consistently loses the first or last tone can still complete because
 * the reassembler accepts the fragments in any order. */
export function rotateHandshakePackets(packets: ControlPacket[], retryRound: number): ControlPacket[] {
  if (!Number.isInteger(retryRound) || retryRound < 0) throw new Error('Invalid handshake retry round')
  if (packets.length < 2) return packets.slice()
  const offset = retryRound * 7 % packets.length
  return packets.slice(offset).concat(packets.slice(0, offset))
}
/** Re-sequence only the requested response data fragments. The receiver must
 * separately verify the optical NACK's full session ID and expected format. */
export function selectHandshakeResponseFragments(packets: ControlPacket[], missingMask: number, sequenceStart: number) {
  if (!packets.length || !Number.isInteger(missingMask) || missingMask <= 0) return []
  const first = packets[0]
  const dense = first.type === ControlType.HANDSHAKE_DENSE_FRAGMENT
  const parsed = dense ? parseDenseHandshakeFragment(first) : parseHandshakeFragment(first)
  if (!parsed || (!dense && (parsed as AcousticFragment).messageType !== 1)) return []
  const count = dense ? (parsed as DenseHandshakeFragment).dataCount : (parsed as AcousticFragment).count
  if (count > 31 || missingMask >>> count) return []
  const selected: ControlPacket[] = []
  for (let index = 0; index < count; index += 1) if ((missingMask >>> index) & 1) {
    const original = packets.find(packet => {
      if (packet.type !== first.type || packet.transferId !== first.transferId) return false
      const item = dense ? parseDenseHandshakeFragment(packet) : parseHandshakeFragment(packet)
      return !!item && item.index === index && (dense ? (item as DenseHandshakeFragment).totalLength === (parsed as DenseHandshakeFragment).totalLength : (item as AcousticFragment).messageType === 1)
    })
    if (!original) return []
    selected.push({ ...original, sequence: (sequenceStart + selected.length) & 0xffff })
  }
  return selected
}
export function selectHandshakeNackRetransmissions(nack: HandshakeNack, sessionId: Uint8Array, responsePackets: ControlPacket[], sequenceStart: number) {
  if (!equalBytes(nack.sessionId, sessionId) || !responsePackets.length) return []
  const dense = responsePackets[0].type === ControlType.HANDSHAKE_DENSE_FRAGMENT
  if (nack.format !== (dense ? HANDSHAKE_NACK_DENSE : HANDSHAKE_NACK_LEGACY)) return []
  const first = dense ? parseDenseHandshakeFragment(responsePackets[0]) : parseHandshakeFragment(responsePackets[0])
  const count = dense ? (first as DenseHandshakeFragment | null)?.dataCount : (first as AcousticFragment | null)?.count
  if (!count || nack.count !== count) return []
  return selectHandshakeResponseFragments(responsePackets, nack.missingMask, sequenceStart)
}
/** A repeated optical NACK frame is not a new request. This only gates
 * retransmission; it grants no handshake-state authority. */
export function isFreshHandshakeNackRequest(requestId: number, lastRequestId: number | undefined, now: number, lastAt: number | undefined, minimumIntervalMs = 700) {
  if (!Number.isInteger(requestId) || requestId < 0 || requestId > 65535 || !Number.isFinite(now)) return false
  if (lastAt !== undefined && now - lastAt < minimumIntervalMs) return false
  if (lastRequestId === undefined) return true
  const advance = (requestId - lastRequestId + 65536) & 0xffff
  return advance > 0 && advance <= 32767
}
export function parseHandshakeFragment(packet: ControlPacket): AcousticFragment | null {
  if (packet.type !== ControlType.HANDSHAKE_FRAGMENT || packet.payload.length < 7 || packet.payload.length > CONTROL_MAX_PAYLOAD) return null
  const view = new DataView(packet.payload.buffer, packet.payload.byteOffset, packet.payload.byteLength), sessionTag = view.getUint16(0), messageType = packet.payload[2], index = packet.payload[3], count = packet.payload[4], totalLength = packet.payload[5], data = packet.payload.slice(6)
  if (!count || count > MAX_HANDSHAKE_FRAGMENTS || index >= count || !totalLength || totalLength > MAX_HANDSHAKE_MESSAGE_BYTES || data.length > HANDSHAKE_FRAGMENT_DATA_BYTES || (index < count - 1 && data.length !== HANDSHAKE_FRAGMENT_DATA_BYTES) || totalLength > count * HANDSHAKE_FRAGMENT_DATA_BYTES || totalLength <= (count - 1) * HANDSHAKE_FRAGMENT_DATA_BYTES) return null
  return { sessionTag, messageType, index, count, data }
}
export class AcousticFragmentReassembler {
  private readonly assemblies = new Map<string, { createdAt: number; totalLength: number; pieces: Map<number, Uint8Array> }>()
  private readonly expiryMs: number
  // Leave room for slower two-tone peers and a full retransmission.
  constructor(expiryMs = 180_000) { this.expiryMs = expiryMs }
  clear() { this.assemblies.clear() }
  missing(transferId: number, sessionTag: number, messageType: number, now = Date.now()) {
    this.expire(now)
    const assembly = [...this.assemblies].filter(([key]) => key.startsWith(`${transferId}:${sessionTag}:${messageType}:`)).sort((left, right) => right[1].pieces.size - left[1].pieces.size)[0]
    if (!assembly) return null
    const count = Number(assembly[0].split(':')[3])
    return { count, received: assembly[1].pieces.size, missing: Array.from({ length: count }, (_, index) => index).filter(index => !assembly[1].pieces.has(index)) }
  }
  add(packet: ControlPacket, now = Date.now()): { messageType: number; message: Uint8Array } | null {
    this.expire(now); const fragment = parseHandshakeFragment(packet); if (!fragment) return null
    const totalLength = packet.payload[5], key = `${packet.transferId}:${fragment.sessionTag}:${fragment.messageType}:${fragment.count}:${totalLength}`
    let assembly = this.assemblies.get(key)
    if (!assembly) { if (this.assemblies.size >= 4) this.assemblies.delete(this.assemblies.keys().next().value!); assembly = { createdAt: now, totalLength, pieces: new Map() }; this.assemblies.set(key, assembly) }
    const existing = assembly.pieces.get(fragment.index)
    if (existing && !existing.every((value, i) => value === fragment.data[i])) { this.assemblies.delete(key); return null }
    assembly.pieces.set(fragment.index, fragment.data)
    if (assembly.pieces.size !== fragment.count) return null
    const message = new Uint8Array(totalLength)
    for (let index = 0; index < fragment.count; index += 1) { const data = assembly.pieces.get(index); if (!data) return null; message.set(data, index * HANDSHAKE_FRAGMENT_DATA_BYTES) }
    this.assemblies.delete(key); return { messageType: fragment.messageType, message }
  }
  private expire(now: number) { for (const [key, value] of this.assemblies) if (now - value.createdAt > this.expiryMs) this.assemblies.delete(key) }
}
