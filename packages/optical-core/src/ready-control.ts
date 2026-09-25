import { ControlType, type ControlPacket } from './control.ts'

/** Two ordinary CRC16-protected packets carry a full 128-bit confirmation MAC.
 * Packet transferId routes the active session; the MAC authenticates its full
 * cryptographic transcript. Compact runtime ACK packets are not changed. */
export function fastReadyPackets(transferId: number, sequenceStart: number, mac: Uint8Array): ControlPacket[] {
  if (mac.length !== 16) throw new Error('Fast READY requires a 128-bit MAC')
  return [0, 1].map(index => ({ type: ControlType.HANDSHAKE_COMPLETE, transferId, sequence: (sequenceStart + index) & 0xffff, payload: Uint8Array.of(index, ...mac.subarray(index * 8, index * 8 + 8)) }))
}

export class FastReadyAssembler {
  private readonly parts: Array<Uint8Array | undefined> = [undefined, undefined]
  private readonly expiryMs: number
  private firstAt = -1
  constructor(expiryMs = 30_000) { this.expiryMs = expiryMs }
  clear() { this.parts[0] = undefined; this.parts[1] = undefined; this.firstAt = -1 }
  add(packet: ControlPacket, expectedTransferId: number, now = Date.now()): Uint8Array | null {
    if (packet.type !== ControlType.HANDSHAKE_COMPLETE || packet.transferId !== expectedTransferId || packet.payload.length !== 9 || packet.payload[0] > 1) return null
    if (this.firstAt >= 0 && now - this.firstAt > this.expiryMs) this.clear()
    if (this.firstAt < 0) this.firstAt = now
    const index = packet.payload[0], part = packet.payload.subarray(1), existing = this.parts[index]
    if (existing && !existing.every((value, offset) => value === part[offset])) { this.clear(); return null }
    this.parts[index] = part.slice()
    if (!this.parts[0] || !this.parts[1]) return null
    const mac = new Uint8Array(16)
    mac.set(this.parts[0]); mac.set(this.parts[1], 8)
    this.clear()
    return mac
  }
}
