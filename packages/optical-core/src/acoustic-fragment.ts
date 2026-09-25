import { CONTROL_MAX_PAYLOAD, ControlType, type ControlPacket } from './control.ts'

export const HANDSHAKE_FRAGMENT_DATA_BYTES = 6
export const MAX_HANDSHAKE_FRAGMENTS = 64
export const MAX_HANDSHAKE_MESSAGE_BYTES = Math.min(255, MAX_HANDSHAKE_FRAGMENTS * HANDSHAKE_FRAGMENT_DATA_BYTES)
export interface AcousticFragment { sessionTag: number; messageType: number; index: number; count: number; data: Uint8Array }

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
export function parseHandshakeFragment(packet: ControlPacket): AcousticFragment | null {
  if (packet.type !== ControlType.HANDSHAKE_FRAGMENT || packet.payload.length < 7 || packet.payload.length > CONTROL_MAX_PAYLOAD) return null
  const view = new DataView(packet.payload.buffer, packet.payload.byteOffset, packet.payload.byteLength), sessionTag = view.getUint16(0), messageType = packet.payload[2], index = packet.payload[3], count = packet.payload[4], totalLength = packet.payload[5], data = packet.payload.slice(6)
  if (!count || count > MAX_HANDSHAKE_FRAGMENTS || index >= count || !totalLength || totalLength > MAX_HANDSHAKE_MESSAGE_BYTES || data.length > HANDSHAKE_FRAGMENT_DATA_BYTES || (index < count - 1 && data.length !== HANDSHAKE_FRAGMENT_DATA_BYTES) || totalLength > count * HANDSHAKE_FRAGMENT_DATA_BYTES || totalLength <= (count - 1) * HANDSHAKE_FRAGMENT_DATA_BYTES) return null
  return { sessionTag, messageType, index, count, data }
}
export class AcousticFragmentReassembler {
  private readonly assemblies = new Map<string, { createdAt: number; totalLength: number; pieces: Map<number, Uint8Array> }>()
  private readonly expiryMs: number
  // Eighteen full FSK packets take roughly 80 seconds with the current speaker
  // scheduler. Leave room for a missed tone and a complete retransmission.
  constructor(expiryMs = 180_000) { this.expiryMs = expiryMs }
  clear() { this.assemblies.clear() }
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
