/** Versioned, bounded local phone/desktop messages. The relay only forwards
 * these bytes; the desktop authenticates encrypted blocks with AES-GCM. */
export const PHONE_CONTROL_MAX = 512
export const PHONE_BLOCK_MAX = 30_000
export const PHONE_CAMERA_FRAME_MAX = 8 * 1024 * 1024
export const PHONE_DECODE_REASONS = ['unknown', 'valid', 'finder', 'metadata', 'torn-frame', 'payload-length', 'payload-crc'] as const
export const PHONE_FINDER_STAGES = ['unknown', 'searching', 'tracked', 'near-reacquired', 'top-left', 'top-right', 'bottom-right', 'bottom-left', 'complete', 'worker-error', 'tracked-90°', 'tracked-180°', 'tracked-270°'] as const
export const PHONE_CAPTURE_PATHS = ['unknown', 'camera-track worker', 'video-frame callback', 'animation-frame fallback', 'phone camera → desktop decoder'] as const
const MAGIC = 0x504f
const VERSION = 1
const KIND = { control: 1, observation: 2, block: 3, telemetry: 4, config: 5, ack: 6, cameraFrame: 7, cameraAck: 8, cameraPath: 9 } as const

export type PhoneRelayMessage =
  | { kind: 'control'; profileId: number; frameId: number; blockId: number; payload: Uint8Array }
  | { kind: 'observation'; profileId: number; frameId: number; transferId: number; blockId: number; shardIndex: number }
  | { kind: 'block'; profileId: number; transferId: number; blockId: number; visit: number; bytes: Uint8Array }
  | { kind: 'telemetry'; cameraFps: number; processedFps: number; validFps: number; uniqueFps: number; failures: number; recoveredBlocks: number; repeatedFrames: number; usefulShards: number; usefulShardBytes: number; decodeReason?: number; finderStage?: number; pixelsPerCell?: number; capturePath?: number }
  | { kind: 'config'; profileId: number; transferId: number }
  | { kind: 'ack'; transferId: number; blockId: number }
  | { kind: 'camera-frame'; profileId: number; sequence: number; png: Uint8Array }
  | { kind: 'camera-ack'; sequence: number; valid: boolean; decodeReason: number; frameId: number }
  | { kind: 'camera-path'; lossless: boolean }

function uint32(value: number) { return Number.isInteger(value) && value >= 0 && value <= 0xffffffff }
function byte(value: number) { return Number.isInteger(value) && value >= 0 && value <= 255 }
function base(kind: number, length: number) {
  const packet = new Uint8Array(length)
  const view = new DataView(packet.buffer)
  view.setUint16(0, MAGIC); packet[2] = VERSION; packet[3] = kind
  return { packet, view }
}
export function encodePhoneRelayMessage(message: PhoneRelayMessage) {
  if (message.kind === 'camera-path') {
    const { packet } = base(KIND.cameraPath, 5)
    packet[4] = message.lossless ? 1 : 0
    return packet
  }
  if (message.kind === 'camera-frame') {
    if (!byte(message.profileId) || !uint32(message.sequence) || message.png.length < 8 || message.png.length > PHONE_CAMERA_FRAME_MAX || !isPng(message.png)) throw new Error('Invalid phone camera frame')
    const { packet, view } = base(KIND.cameraFrame, 13 + message.png.length)
    packet[4] = message.profileId; view.setUint32(5, message.sequence); view.setUint32(9, message.png.length); packet.set(message.png, 13); return packet
  }
  if (message.kind === 'camera-ack') {
    if (!uint32(message.sequence) || !byte(message.decodeReason) || !uint32(message.frameId)) throw new Error('Invalid phone camera acknowledgement')
    const { packet, view } = base(KIND.cameraAck, 14)
    view.setUint32(4, message.sequence); packet[8] = message.valid ? 1 : 0; packet[9] = message.decodeReason; view.setUint32(10, message.frameId); return packet
  }
  if (message.kind === 'control') {
    if (!byte(message.profileId) || !uint32(message.frameId) || !uint32(message.blockId) || message.payload.length > PHONE_CONTROL_MAX) throw new Error('Invalid phone control frame')
    const { packet, view } = base(KIND.control, 15 + message.payload.length)
    packet[4] = message.profileId; view.setUint32(5, message.frameId); view.setUint32(9, message.blockId); view.setUint16(13, message.payload.length); packet.set(message.payload, 15); return packet
  }
  if (message.kind === 'observation') {
    if (!byte(message.profileId) || !uint32(message.frameId) || !uint32(message.transferId) || !uint32(message.blockId) || !byte(message.shardIndex)) throw new Error('Invalid phone observation')
    const { packet, view } = base(KIND.observation, 18)
    packet[4] = message.profileId; view.setUint32(5, message.frameId); view.setUint32(9, message.transferId); view.setUint32(13, message.blockId); packet[17] = message.shardIndex; return packet
  }
  if (message.kind === 'block') {
    if (!byte(message.profileId) || !uint32(message.transferId) || !uint32(message.blockId) || !uint32(message.visit) || message.bytes.length < 16 || message.bytes.length > PHONE_BLOCK_MAX) throw new Error('Invalid phone block')
    const { packet, view } = base(KIND.block, 21 + message.bytes.length)
    packet[4] = message.profileId; view.setUint32(5, message.transferId); view.setUint32(9, message.blockId); view.setUint32(13, message.visit); view.setUint32(17, message.bytes.length); packet.set(message.bytes, 21); return packet
  }
  if (message.kind === 'telemetry') {
    const fps = [message.cameraFps, message.processedFps, message.validFps, message.uniqueFps]
    if (fps.some(value => !Number.isFinite(value) || value < 0 || value > 6553.5) || !uint32(message.failures) || !uint32(message.recoveredBlocks) || !uint32(message.repeatedFrames) || !uint32(message.usefulShards) || !uint32(message.usefulShardBytes)) throw new Error('Invalid phone telemetry')
    const detailed = message.decodeReason !== undefined || message.finderStage !== undefined || message.pixelsPerCell !== undefined || message.capturePath !== undefined
    if (detailed && (!byte(message.decodeReason ?? -1) || !byte(message.finderStage ?? -1) || !Number.isFinite(message.pixelsPerCell) || message.pixelsPerCell! < 0 || message.pixelsPerCell! > 6553.5 || !byte(message.capturePath ?? -1))) throw new Error('Invalid phone decode diagnostics')
    const { packet, view } = base(KIND.telemetry, detailed ? 37 : 32)
    fps.forEach((value, index) => view.setUint16(4 + index * 2, Math.round(value * 10)))
    view.setUint32(12, message.failures); view.setUint32(16, message.recoveredBlocks); view.setUint32(20, message.repeatedFrames); view.setUint32(24, message.usefulShards); view.setUint32(28, message.usefulShardBytes)
    if (detailed) { packet[32] = message.decodeReason!; packet[33] = message.finderStage!; view.setUint16(34, Math.round(message.pixelsPerCell! * 10)); packet[36] = message.capturePath! }
    return packet
  }
  if (message.kind === 'config') {
    if (!byte(message.profileId) || !uint32(message.transferId)) throw new Error('Invalid phone configuration')
    const { packet, view } = base(KIND.config, 9)
    packet[4] = message.profileId; view.setUint32(5, message.transferId); return packet
  }
  if (!uint32(message.transferId) || !uint32(message.blockId)) throw new Error('Invalid phone block receipt')
  const { packet, view } = base(KIND.ack, 12)
  view.setUint32(4, message.transferId); view.setUint32(8, message.blockId); return packet
}

export function decodePhoneRelayMessage(packet: Uint8Array): PhoneRelayMessage | null {
  if (packet.length < 4 || packet.length > PHONE_CAMERA_FRAME_MAX + 13 || new DataView(packet.buffer, packet.byteOffset, packet.byteLength).getUint16(0) !== MAGIC || packet[2] !== VERSION) return null
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength)
  if (packet[3] === KIND.cameraFrame && packet.length >= 21 && view.getUint32(9) >= 8 && view.getUint32(9) <= PHONE_CAMERA_FRAME_MAX && packet.length === 13 + view.getUint32(9) && isPng(packet.subarray(13, 21))) return { kind: 'camera-frame', profileId: packet[4], sequence: view.getUint32(5), png: packet.slice(13) }
  if (packet[3] === KIND.cameraAck && packet.length === 14 && packet[8] <= 1) return { kind: 'camera-ack', sequence: view.getUint32(4), valid: packet[8] === 1, decodeReason: packet[9], frameId: view.getUint32(10) }
  if (packet[3] === KIND.cameraPath && packet.length === 5 && packet[4] <= 1) return { kind: 'camera-path', lossless: packet[4] === 1 }
  if (packet[3] === KIND.control && packet.length >= 15 && view.getUint16(13) <= PHONE_CONTROL_MAX && packet.length === 15 + view.getUint16(13)) return { kind: 'control', profileId: packet[4], frameId: view.getUint32(5), blockId: view.getUint32(9), payload: packet.slice(15) }
  if (packet[3] === KIND.observation && packet.length === 18) return { kind: 'observation', profileId: packet[4], frameId: view.getUint32(5), transferId: view.getUint32(9), blockId: view.getUint32(13), shardIndex: packet[17] }
  if (packet[3] === KIND.block && packet.length >= 37 && view.getUint32(17) <= PHONE_BLOCK_MAX && packet.length === 21 + view.getUint32(17)) return { kind: 'block', profileId: packet[4], transferId: view.getUint32(5), blockId: view.getUint32(9), visit: view.getUint32(13), bytes: packet.slice(21) }
  if (packet[3] === KIND.telemetry && (packet.length === 32 || packet.length === 37)) return { kind: 'telemetry', cameraFps: view.getUint16(4) / 10, processedFps: view.getUint16(6) / 10, validFps: view.getUint16(8) / 10, uniqueFps: view.getUint16(10) / 10, failures: view.getUint32(12), recoveredBlocks: view.getUint32(16), repeatedFrames: view.getUint32(20), usefulShards: view.getUint32(24), usefulShardBytes: view.getUint32(28), ...(packet.length === 37 ? { decodeReason: packet[32], finderStage: packet[33], pixelsPerCell: view.getUint16(34) / 10, capturePath: packet[36] } : {}) }
  if (packet[3] === KIND.config && packet.length === 9) return { kind: 'config', profileId: packet[4], transferId: view.getUint32(5) }
  if (packet[3] === KIND.ack && packet.length === 12) return { kind: 'ack', transferId: view.getUint32(4), blockId: view.getUint32(8) }
  return null
}

function isPng(bytes: Uint8Array) { return bytes.length >= 8 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71 && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10 }
