import { CONTROL_MAX_PAYLOAD, ControlType, FSK_SYMBOL_SECONDS, packCompactControlPacket, packControlPacket, unpackCompactControlPacket, unpackControlPacket, type ControlPacket } from './control.ts'

/** One of eight evenly spaced tones per 16 ms symbol, three bits each.
 * The 250 Hz spacing is exactly four cycles per symbol. Packet bytes and CRC
 * remain identical to the two- and four-tone physical modes. */
export const OCTAL_FSK_TONES_HZ = [1000, 1250, 1500, 1750, 2000, 2250, 2500, 2750] as const
export const OCTAL_FSK_SYNC_HZ = 3250
const PREAMBLE = Uint8Array.of(0xe2, 0x5a, 0x97) // 24 bits = eight three-bit symbols
const GRAY = [0, 1, 3, 2, 6, 7, 5, 4] as const
const GRAY_TO_TONE = [0, 1, 3, 2, 7, 6, 4, 5] as const
const COMPACT_MAGIC = 0xc7
const COMPACT_BYTES = 14
const SYNC_SYMBOLS = 2

function toneEnergy(samples: Float32Array, start: number, length: number, frequency: number, sampleRate: number) {
  const coefficient = 2 * Math.cos(2 * Math.PI * frequency / sampleRate)
  let previous = 0, beforePrevious = 0
  for (let index = 0; index < length; index += 1) {
    const current = samples[start + index] + coefficient * previous - beforePrevious
    beforePrevious = previous; previous = current
  }
  return previous * previous + beforePrevious * beforePrevious - coefficient * previous * beforePrevious
}

function encodeBody(body: Uint8Array, sampleRate: number) {
  const bytes = new Uint8Array(PREAMBLE.length + body.length)
  bytes.set(PREAMBLE); bytes.set(body, PREAMBLE.length)
  const symbolSamples = Math.round(sampleRate * FSK_SYMBOL_SECONDS), edgeSilence = Math.round(sampleRate * 0.008)
  const output = new Float32Array(edgeSilence * 2 + SYNC_SYMBOLS * symbolSamples + Math.ceil(bytes.length * 8 / 3) * symbolSamples)
  let phase = 0
  const tone = (start: number, length: number, frequency: number) => {
    const increment = 2 * Math.PI * frequency / sampleRate
    for (let index = 0; index < length; index += 1) {
      const edge = Math.min(1, index / 24, (length - index - 1) / 24)
      output[start + index] = Math.sin(phase) * 0.42 * Math.max(0, edge)
      phase += increment
    }
  }
  tone(edgeSilence, SYNC_SYMBOLS * symbolSamples, OCTAL_FSK_SYNC_HZ)
  let position = edgeSilence + SYNC_SYMBOLS * symbolSamples
  for (let bit = 0; bit < bytes.length * 8; bit += 3) {
    let value = 0
    for (let offset = 0; offset < 3; offset += 1) {
      const at = bit + offset
      value = (value << 1) | (at < bytes.length * 8 ? (bytes[at >>> 3] >>> (7 - (at & 7))) & 1 : 0)
    }
    tone(position, symbolSamples, OCTAL_FSK_TONES_HZ[GRAY_TO_TONE[value]])
    position += symbolSamples
  }
  return output
}

export function encodeOctalFskPacket(packet: ControlPacket, sampleRate = 48000) { return encodeBody(packControlPacket(packet), sampleRate) }
export function encodeOctalCompactFskPacket(packet: ControlPacket, sampleRate = 48000) { return encodeBody(packCompactControlPacket(packet), sampleRate) }
export function encodeOctalFskHandshakePacket(packet: ControlPacket, sampleRate = 48000) {
  if (packet.type !== ControlType.HANDSHAKE_FRAGMENT) throw new Error('Eight-tone handshake encoder requires a fragment')
  return encodeOctalFskPacket(packet, sampleRate)
}

/** Sync tone + preamble + CRC must all match. Search eight clock phases to
 * tolerate capture start offsets without changing the legacy packet format. */
export function decodeOctalFskSamples(samples: Float32Array, sampleRate: number): ControlPacket[] {
  const symbolSamples = Math.round(sampleRate * FSK_SYMBOL_SECONDS)
  const preambleSymbols = new Uint8Array(8)
  for (let symbol = 0; symbol < 8; symbol += 1) for (let bit = 0; bit < 3; bit += 1) preambleSymbols[symbol] = (preambleSymbols[symbol] << 1) | ((PREAMBLE[(symbol * 3 + bit) >>> 3] >>> (7 - ((symbol * 3 + bit) & 7))) & 1)
  const found = new Map<string, { packet: ControlPacket; position: number }>()
  for (let phase = 0; phase < symbolSamples; phase += Math.max(1, Math.floor(symbolSamples / 8))) {
    const count = Math.floor((samples.length - phase) / symbolSamples)
    if (count < SYNC_SYMBOLS + preambleSymbols.length + Math.ceil(13 * 8 / 3)) continue
    const symbols = new Uint8Array(count)
    for (let index = 0; index < count; index += 1) {
      const start = phase + index * symbolSamples
      let best = 0, bestEnergy = -1
      for (let tone = 0; tone < OCTAL_FSK_TONES_HZ.length; tone += 1) {
        const energy = toneEnergy(samples, start, symbolSamples, OCTAL_FSK_TONES_HZ[tone], sampleRate)
        if (energy > bestEnergy) { bestEnergy = energy; best = tone }
      }
      symbols[index] = GRAY[best]
    }
    const byteAt = (bodyStart: number, byteIndex: number) => {
      let value = 0
      for (let bit = 0; bit < 8; bit += 1) {
        const at = byteIndex * 8 + bit, symbol = symbols[bodyStart + Math.floor(at / 3)]
        value = (value << 1) | ((symbol >>> (2 - (at % 3))) & 1)
      }
      return value
    }
    for (let offset = SYNC_SYMBOLS; offset + preambleSymbols.length + Math.ceil(13 * 8 / 3) <= count; offset += 1) {
      if (preambleSymbols.some((value, index) => symbols[offset + index] !== value)) continue
      const syncStart = phase + (offset - SYNC_SYMBOLS) * symbolSamples, syncLength = SYNC_SYMBOLS * symbolSamples
      const syncEnergy = toneEnergy(samples, syncStart, syncLength, OCTAL_FSK_SYNC_HZ, sampleRate)
      let dataEnergy = 0
      for (const frequency of OCTAL_FSK_TONES_HZ) dataEnergy = Math.max(dataEnergy, toneEnergy(samples, syncStart, syncLength, frequency, sampleRate))
      if (syncEnergy <= dataEnergy * 3 || syncEnergy <= 0) continue
      const bodyStart = offset + preambleSymbols.length, compact = byteAt(bodyStart, 0) === COMPACT_MAGIC
      const payloadLength = compact ? 0 : byteAt(bodyStart, 10), bodyLength = compact ? COMPACT_BYTES : 13 + payloadLength
      if (payloadLength > CONTROL_MAX_PAYLOAD || bodyStart + Math.ceil(bodyLength * 8 / 3) > count) continue
      const body = new Uint8Array(bodyLength)
      for (let index = 0; index < bodyLength; index += 1) body[index] = byteAt(bodyStart, index)
      const packet = compact ? unpackCompactControlPacket(body) : unpackControlPacket(body)
      if (!packet) continue
      const key = `${packet.transferId}:${packet.sequence}:${packet.type}`
      if (!found.has(key) || syncStart < found.get(key)!.position) found.set(key, { packet, position: syncStart })
    }
  }
  return [...found.values()].sort((left, right) => left.position - right.position).map(item => item.packet)
}
