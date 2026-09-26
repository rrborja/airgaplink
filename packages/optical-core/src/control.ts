/** Physical speaker-to-microphone control only. No archive bytes or file metadata
 * are accepted by this packet format. */
export const ControlType = { HELLO: 1, READY: 2, PROFILE_SELECTED: 3, BLOCK_STATUS: 4, TRANSFER_COMPLETE: 5, PAUSE: 6, RESUME: 7, CANCEL: 8, CALIBRATION_SELECTED: 9, HANDSHAKE_FRAGMENT: 10, HANDSHAKE_COMPLETE: 11, OPTICAL_QUALITY: 12, HANDSHAKE_DENSE_FRAGMENT: 13, ACOUSTIC_PROBE: 14, MISSING_HINT: 15 } as const
export type ControlType = typeof ControlType[keyof typeof ControlType]
export interface ControlPacket { type: ControlType; transferId: number; sequence: number; payload: Uint8Array }
const CONTROL_MAGIC = 0xa55a
const CONTROL_VERSION = 1
const PREAMBLE = Uint8Array.of(0x55, 0x55, 0x55, 0x55, 0xd3)
const COMPACT_PREAMBLE = Uint8Array.of(0xd5, 0x3a)
const QUAD_PREAMBLE = Uint8Array.of(0xd2, 0xa9, 0x6c, 0x35)
const COMPACT_MAGIC = 0xc7
const COMPACT_BYTES = 14
export const CONTROL_MAX_PAYLOAD = 12
export const FSK_SYMBOL_SECONDS = 0.016
export const FSK_ZERO_HZ = 1700
export const FSK_ONE_HZ = 2300
export const QUAD_FSK_TONES_HZ = [1300, 1700, 2100, 2500] as const
export const QUAD_FSK_SYNC_HZ = 3100
const QUAD_SYNC_SYMBOLS = 2
// Gray order: neighboring tones differ by one data bit.
const QUAD_GRAY_MAP = [0, 1, 3, 2] as const

function crc16(bytes: Uint8Array) {
  let crc = 0xffff
  for (const value of bytes) { crc ^= value << 8; for (let bit = 0; bit < 8; bit += 1) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff }
  return crc
}

export function packControlPacket(packet: ControlPacket) {
  if (packet.payload.length > CONTROL_MAX_PAYLOAD || !Object.values(ControlType).includes(packet.type)) throw new Error('Invalid acoustic control packet')
  const bytes = new Uint8Array(13 + packet.payload.length), view = new DataView(bytes.buffer)
  view.setUint16(0, CONTROL_MAGIC); bytes[2] = CONTROL_VERSION; bytes[3] = packet.type
  view.setUint32(4, packet.transferId); view.setUint16(8, packet.sequence)
  bytes[10] = packet.payload.length; bytes.set(packet.payload, 11)
  view.setUint16(bytes.length - 2, crc16(bytes.subarray(0, bytes.length - 2)))
  return bytes
}

export function unpackControlPacket(bytes: Uint8Array): ControlPacket | null {
  if (bytes.length < 13 || bytes.length > 13 + CONTROL_MAX_PAYLOAD) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint16(0) !== CONTROL_MAGIC || bytes[2] !== CONTROL_VERSION || bytes[10] !== bytes.length - 13 || view.getUint16(bytes.length - 2) !== crc16(bytes.subarray(0, bytes.length - 2))) return null
  if (bytes[3] < ControlType.HELLO || bytes[3] > ControlType.MISSING_HINT) return null
  return { type: bytes[3] as ControlType, transferId: view.getUint32(4), sequence: view.getUint16(8), payload: bytes.slice(11, bytes.length - 2) }
}

export function makeBlockStatusPayload(baseBlock: number, bitmap: number) {
  const bytes = new Uint8Array(8), view = new DataView(bytes.buffer)
  view.setUint32(0, baseBlock); view.setUint32(4, bitmap)
  return bytes
}
export function readBlockStatusPayload(bytes: Uint8Array) {
  if (bytes.length !== 8) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { baseBlock: view.getUint32(0), bitmap: view.getUint32(4) }
}

/** After optical pairing, a cumulative floor plus four nearby block bits is
 * enough to resynchronize a four-block sender window in a much shorter tone. */
export function makeCompactStatusPayload(firstMissing: number, bitmap: number, paceCode = 0) {
  if (!Number.isInteger(firstMissing) || firstMissing < 0 || firstMissing > 0xffffff || !Number.isInteger(bitmap) || bitmap < 0 || bitmap > 15 || !Number.isInteger(paceCode) || paceCode < 0 || paceCode > 15) throw new Error('Invalid compact block status')
  return Uint8Array.of(firstMissing >>> 16, firstMissing >>> 8, firstMissing, (paceCode << 4) | bitmap)
}
export function readCompactStatusPayload(bytes: Uint8Array) {
  if (bytes.length !== 4) return null
  return { firstMissing: bytes[0] * 65536 + bytes[1] * 256 + bytes[2], bitmap: bytes[3] & 15, paceCode: bytes[3] >>> 4 }
}

/** Optional sparse scheduling hint. It is not an ACK: stale or missing hints
 * cannot suppress the sender's sequential cyclic scan. */
export function makeMissingHintPayload(windowBase: number, missingMask: number, completedCount: number) {
  if (![windowBase, missingMask, completedCount].every(value => Number.isInteger(value) && value >= 0 && value <= 0xffffffff) || !missingMask || windowBase % 32) throw new Error('Invalid missing-block hint')
  const bytes = new Uint8Array(12), view = new DataView(bytes.buffer)
  view.setUint32(0, windowBase); view.setUint32(4, missingMask); view.setUint32(8, completedCount)
  return bytes
}
export function readMissingHintPayload(bytes: Uint8Array) {
  if (bytes.length !== 12) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const windowBase = view.getUint32(0), missingMask = view.getUint32(4), completedCount = view.getUint32(8)
  return windowBase % 32 || !missingMask ? null : { windowBase, missingMask, completedCount }
}

export function packCompactControlPacket(packet: ControlPacket) {
  if (packet.type !== ControlType.READY && packet.type !== ControlType.BLOCK_STATUS && packet.type !== ControlType.TRANSFER_COMPLETE && packet.type !== ControlType.CALIBRATION_SELECTED) throw new Error('Unsupported compact control type')
  if (packet.type === ControlType.TRANSFER_COMPLETE ? packet.payload.length !== 0 : packet.type === ControlType.CALIBRATION_SELECTED ? packet.payload.length !== 4 : !readCompactStatusPayload(packet.payload)) throw new Error('Invalid compact control payload')
  const bytes = new Uint8Array(COMPACT_BYTES), view = new DataView(bytes.buffer)
  bytes[0] = COMPACT_MAGIC; bytes[1] = (CONTROL_VERSION << 4) | packet.type
  view.setUint32(2, packet.transferId); view.setUint16(6, packet.sequence)
  if (packet.payload.length) bytes.set(packet.payload, 8)
  view.setUint16(12, crc16(bytes.subarray(0, 12)))
  return bytes
}

export function unpackCompactControlPacket(bytes: Uint8Array): ControlPacket | null {
  if (bytes.length !== COMPACT_BYTES) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const type = bytes[1] & 15
  if (bytes[0] !== COMPACT_MAGIC || bytes[1] >>> 4 !== CONTROL_VERSION || (type !== ControlType.READY && type !== ControlType.BLOCK_STATUS && type !== ControlType.TRANSFER_COMPLETE && type !== ControlType.CALIBRATION_SELECTED) || view.getUint16(12) !== crc16(bytes.subarray(0, 12))) return null
  const payload = type === ControlType.TRANSFER_COMPLETE ? new Uint8Array() : bytes.slice(8, 12)
  if ((type === ControlType.READY || type === ControlType.BLOCK_STATUS) && !readCompactStatusPayload(payload)) return null
  return { type: type as ControlType, transferId: view.getUint32(2), sequence: view.getUint16(6), payload }
}

function encodeFskBytes(data: Uint8Array, sampleRate: number) {
  const symbolSamples = Math.round(sampleRate * FSK_SYMBOL_SECONDS), silence = Math.round(sampleRate * 0.05)
  const output = new Float32Array(silence * 2 + data.length * 8 * symbolSamples)
  let phase = 0
  for (let bitIndex = 0; bitIndex < data.length * 8; bitIndex += 1) {
    const bit = (data[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1
    const increment = 2 * Math.PI * (bit ? FSK_ONE_HZ : FSK_ZERO_HZ) / sampleRate
    const start = silence + bitIndex * symbolSamples
    for (let sample = 0; sample < symbolSamples; sample += 1) {
      const edge = Math.min(1, sample / 24, (symbolSamples - sample - 1) / 24)
      output[start + sample] = Math.sin(phase) * 0.42 * Math.max(0, edge)
      phase += increment
    }
  }
  return output
}

export function encodeFskPacket(packet: ControlPacket, sampleRate = 48000) {
  const body = packControlPacket(packet), data = new Uint8Array(PREAMBLE.length + body.length)
  data.set(PREAMBLE); data.set(body, PREAMBLE.length)
  return encodeFskBytes(data, sampleRate)
}

export function encodeCompactFskPacket(packet: ControlPacket, sampleRate = 48000) {
  const body = packCompactControlPacket(packet), data = new Uint8Array(COMPACT_PREAMBLE.length + body.length)
  data.set(COMPACT_PREAMBLE); data.set(body, COMPACT_PREAMBLE.length)
  return encodeFskBytes(data, sampleRate)
}

/** The fifth, 32 ms tone marks the packet boundary. The bytes that follow
 * are exactly the existing normal or compact CRC16-protected packet body. */
function encodeQuadFskBody(body: Uint8Array, sampleRate: number) {
  const bytes = new Uint8Array(QUAD_PREAMBLE.length + body.length)
  bytes.set(QUAD_PREAMBLE); bytes.set(body, QUAD_PREAMBLE.length)
  const symbolSamples = Math.round(sampleRate * FSK_SYMBOL_SECONDS), edgeSilence = Math.round(sampleRate * 0.008)
  const syncSamples = QUAD_SYNC_SYMBOLS * symbolSamples
  const output = new Float32Array(2 * edgeSilence + syncSamples + bytes.length * 4 * symbolSamples)
  let phase = 0
  const tone = (start: number, length: number, frequency: number) => {
    const increment = 2 * Math.PI * frequency / sampleRate
    for (let index = 0; index < length; index += 1) {
      const edge = Math.min(1, index / 24, (length - index - 1) / 24)
      output[start + index] = Math.sin(phase) * 0.42 * Math.max(0, edge)
      phase += increment
    }
  }
  tone(edgeSilence, syncSamples, QUAD_FSK_SYNC_HZ)
  let position = edgeSilence + syncSamples
  for (const byte of bytes) for (let shift = 6; shift >= 0; shift -= 2) {
    tone(position, symbolSamples, QUAD_FSK_TONES_HZ[QUAD_GRAY_MAP[(byte >>> shift) & 3]])
    position += symbolSamples
  }
  return output
}
export function encodeQuadFskPacket(packet: ControlPacket, sampleRate = 48000) { return encodeQuadFskBody(packControlPacket(packet), sampleRate) }
export function encodeQuadCompactFskPacket(packet: ControlPacket, sampleRate = 48000) { return encodeQuadFskBody(packCompactControlPacket(packet), sampleRate) }
export function encodeQuadFskHandshakePacket(packet: ControlPacket, sampleRate = 48000) {
  if (packet.type !== ControlType.HANDSHAKE_FRAGMENT && packet.type !== ControlType.HANDSHAKE_DENSE_FRAGMENT) throw new Error('Four-tone handshake encoder requires a fragment')
  return encodeQuadFskPacket(packet, sampleRate)
}

function toneEnergy(samples: Float32Array, start: number, length: number, frequency: number, sampleRate: number) {
  const omega = 2 * Math.PI * frequency / sampleRate, coefficient = 2 * Math.cos(omega)
  let previous = 0, beforePrevious = 0
  for (let index = 0; index < length; index += 1) {
    const current = samples[start + index] + coefficient * previous - beforePrevious
    beforePrevious = previous; previous = current
  }
  return previous * previous + beforePrevious * beforePrevious - coefficient * previous * beforePrevious
}

/** Decode the fifth-tone marker and four-tone payload while preserving the
 * legacy two-tone decoder and exact 14-byte compact packet structure. */
export function decodeQuadFskSamples(samples: Float32Array, sampleRate: number): ControlPacket[] {
  const symbolSamples = Math.round(sampleRate * FSK_SYMBOL_SECONDS), preambleSymbols: number[] = []
  for (const byte of QUAD_PREAMBLE) for (let shift = 6; shift >= 0; shift -= 2) preambleSymbols.push((byte >>> shift) & 3)
  const found = new Map<string, { packet: ControlPacket; position: number }>()
  for (let phase = 0; phase < symbolSamples; phase += Math.max(1, Math.floor(symbolSamples / 8))) {
    const count = Math.floor((samples.length - phase) / symbolSamples)
    if (count < QUAD_SYNC_SYMBOLS + preambleSymbols.length + 13 * 4) continue
    const symbols = new Uint8Array(count)
    for (let index = 0; index < count; index += 1) {
      const start = phase + index * symbolSamples
      let best = 0, bestEnergy = -1
      for (let tone = 0; tone < QUAD_FSK_TONES_HZ.length; tone += 1) {
        const energy = toneEnergy(samples, start, symbolSamples, QUAD_FSK_TONES_HZ[tone], sampleRate)
        if (energy > bestEnergy) { bestEnergy = energy; best = tone }
      }
      symbols[index] = QUAD_GRAY_MAP[best]
    }
    const byteAt = (start: number, index: number) => {
      const offset = start + index * 4
      return (symbols[offset] << 6) | (symbols[offset + 1] << 4) | (symbols[offset + 2] << 2) | symbols[offset + 3]
    }
    for (let offset = QUAD_SYNC_SYMBOLS; offset + preambleSymbols.length + 13 * 4 <= count; offset += 1) {
      if (preambleSymbols.some((value, index) => symbols[offset + index] !== value)) continue
      const syncStart = phase + (offset - QUAD_SYNC_SYMBOLS) * symbolSamples
      const syncLength = QUAD_SYNC_SYMBOLS * symbolSamples
      const syncEnergy = toneEnergy(samples, syncStart, syncLength, QUAD_FSK_SYNC_HZ, sampleRate)
      let dataEnergy = 0
      for (const frequency of QUAD_FSK_TONES_HZ) dataEnergy = Math.max(dataEnergy, toneEnergy(samples, syncStart, syncLength, frequency, sampleRate))
      if (syncEnergy <= dataEnergy * 3 || syncEnergy <= 0) continue
      const bodyStart = offset + preambleSymbols.length, compact = byteAt(bodyStart, 0) === COMPACT_MAGIC
      const payloadLength = compact ? 0 : byteAt(bodyStart, 10), bodyLength = compact ? COMPACT_BYTES : 13 + payloadLength
      if (payloadLength > CONTROL_MAX_PAYLOAD || bodyStart + bodyLength * 4 > count) continue
      const body = new Uint8Array(bodyLength)
      for (let index = 0; index < bodyLength; index += 1) body[index] = byteAt(bodyStart, index)
      const packet = compact ? unpackCompactControlPacket(body) : unpackControlPacket(body)
      if (!packet) continue
      const key = `${packet.transferId}:${packet.sequence}:${packet.type}`, position = syncStart
      if (!found.has(key) || position < found.get(key)!.position) found.set(key, { packet, position })
    }
  }
  return [...found.values()].sort((left, right) => left.position - right.position).map(item => item.packet)
}
export function decodeQuadFskHandshakeSamples(samples: Float32Array, sampleRate: number) { return decodeQuadFskSamples(samples, sampleRate).filter(packet => packet.type === ControlType.HANDSHAKE_FRAGMENT || packet.type === ControlType.HANDSHAKE_DENSE_FRAGMENT) }

/** Search several clock phases; CRC prevents noise from becoming a control event. */
export function decodeFskSamples(samples: Float32Array, sampleRate: number): ControlPacket[] {
  const symbolSamples = Math.round(sampleRate * FSK_SYMBOL_SECONDS), phases = 8, found = new Map<string, { packet: ControlPacket; position: number }>()
  for (let phase = 0; phase < symbolSamples; phase += Math.max(1, Math.floor(symbolSamples / phases))) {
    const count = Math.floor((samples.length - phase) / symbolSamples)
    const bits = new Uint8Array(count)
    for (let index = 0; index < count; index += 1) {
      const start = phase + index * symbolSamples
      bits[index] = toneEnergy(samples, start, symbolSamples, FSK_ONE_HZ, sampleRate) > toneEnergy(samples, start, symbolSamples, FSK_ZERO_HZ, sampleRate) ? 1 : 0
    }
    const matches = (preamble: Uint8Array, offset: number) => {
      if (offset + preamble.length * 8 > bits.length) return false
      for (let index = 0; index < preamble.length * 8; index += 1) if (bits[offset + index] !== ((preamble[index >>> 3] >>> (7 - (index & 7))) & 1)) return false
      return true
    }
    const byteAt = (offset: number, preambleLength: number, position: number) => { let value = 0; for (let bit = 0; bit < 8; bit += 1) value = (value << 1) | bits[offset + (preambleLength + position) * 8 + bit]; return value }
    const record = (packet: ControlPacket | null, position: number) => {
      if (!packet) return
      const key = `${packet.transferId}:${packet.sequence}:${packet.type}`
      const previous = found.get(key)
      if (!previous || position < previous.position) found.set(key, { packet, position })
    }
    for (let offset = 0; offset + (COMPACT_PREAMBLE.length + COMPACT_BYTES) * 8 <= bits.length; offset += 1) {
      if (matches(COMPACT_PREAMBLE, offset)) {
        const body = new Uint8Array(COMPACT_BYTES)
        for (let position = 0; position < body.length; position += 1) body[position] = byteAt(offset, COMPACT_PREAMBLE.length, position)
        record(unpackCompactControlPacket(body), phase + offset * symbolSamples)
      }
      if (!matches(PREAMBLE, offset)) continue
      if (offset + (PREAMBLE.length + 13) * 8 > bits.length) continue
      const payloadLength = byteAt(offset, PREAMBLE.length, 10), length = 13 + payloadLength
      if (payloadLength > CONTROL_MAX_PAYLOAD || offset + (PREAMBLE.length + length) * 8 > bits.length) continue
      const body = new Uint8Array(length)
      for (let position = 0; position < length; position += 1) body[position] = byteAt(offset, PREAMBLE.length, position)
      record(unpackControlPacket(body), phase + offset * symbolSamples)
    }
  }
  return [...found.values()].sort((left, right) => left.position - right.position).map(item => item.packet)
}
