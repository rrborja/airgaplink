import { CONTROL_MAX_PAYLOAD, ControlType, FSK_SYMBOL_SECONDS, packCompactControlPacket, packControlPacket, unpackCompactControlPacket, unpackControlPacket, type ControlPacket } from './control.ts'

/** Experimental high-bandwidth M-ary FSK. Four bits per 16 ms symbol;
 * 250 Hz spacing gives four complete cycles of separation at 16 ms. */
export const HEX_FSK_TONES_HZ = Array.from({ length: 16 }, (_, index) => 1000 + index * 250)
export const HEX_FSK_SYNC_HZ = 5250
const PREAMBLE = Uint8Array.of(0xe2, 0x5a, 0x97)
const SYNC_SYMBOLS = 2
const COMPACT_MAGIC = 0xc7
const COMPACT_BYTES = 14

function energy(samples: Float32Array, start: number, length: number, frequency: number, sampleRate: number) {
  const coefficient = 2 * Math.cos(2 * Math.PI * frequency / sampleRate)
  let previous = 0, beforePrevious = 0
  for (let index = 0; index < length; index += 1) {
    const current = samples[start + index] + coefficient * previous - beforePrevious
    beforePrevious = previous; previous = current
  }
  return previous * previous + beforePrevious * beforePrevious - coefficient * previous * beforePrevious
}
function fittedToneSnrDb(samples: Float32Array, start: number, length: number, frequency: number, sampleRate: number) {
  let cosine = 0, sine = 0, total = 0
  for (let index = 0; index < length; index += 1) {
    const value = samples[start + index], phase = 2 * Math.PI * frequency * index / sampleRate
    cosine += value * Math.cos(phase); sine += value * Math.sin(phase); total += value * value
  }
  const signal = Math.min(total, 2 * (cosine * cosine + sine * sine) / length)
  return total > 0 ? 10 * Math.log10(signal / Math.max(total - signal, 1e-12)) : 0
}

function encodeBody(body: Uint8Array, sampleRate: number) {
  const bytes = new Uint8Array(PREAMBLE.length + body.length)
  bytes.set(PREAMBLE); bytes.set(body, PREAMBLE.length)
  const symbolSamples = Math.round(sampleRate * FSK_SYMBOL_SECONDS), edgeSilence = Math.round(sampleRate * 0.008)
  const output = new Float32Array(edgeSilence * 2 + (SYNC_SYMBOLS + bytes.length * 2) * symbolSamples)
  let phase = 0
  const tone = (start: number, length: number, frequency: number) => {
    const increment = 2 * Math.PI * frequency / sampleRate
    for (let index = 0; index < length; index += 1) {
      const edge = Math.min(1, index / 24, (length - index - 1) / 24)
      output[start + index] = Math.sin(phase) * 0.42 * Math.max(0, edge)
      phase += increment
    }
  }
  tone(edgeSilence, SYNC_SYMBOLS * symbolSamples, HEX_FSK_SYNC_HZ)
  let position = edgeSilence + SYNC_SYMBOLS * symbolSamples
  for (const value of bytes) {
    tone(position, symbolSamples, HEX_FSK_TONES_HZ[value >>> 4]); position += symbolSamples
    tone(position, symbolSamples, HEX_FSK_TONES_HZ[value & 15]); position += symbolSamples
  }
  return output
}

export function encodeHexFskPacket(packet: ControlPacket, sampleRate = 48000) { return encodeBody(packControlPacket(packet), sampleRate) }
export function encodeHexCompactFskPacket(packet: ControlPacket, sampleRate = 48000) { return encodeBody(packCompactControlPacket(packet), sampleRate) }
export function encodeHexFskHandshakePacket(packet: ControlPacket, sampleRate = 48000) {
  if (packet.type !== ControlType.HANDSHAKE_FRAGMENT && packet.type !== ControlType.HANDSHAKE_DENSE_FRAGMENT) throw new Error('16-FSK handshake encoder requires a fragment')
  return encodeHexFskPacket(packet, sampleRate)
}

export interface HexFskDecode { packet: ControlPacket; estimatedSnrDb: number }
/** Decode with a per-packet tone-energy margin. The ratio is an estimated SNR,
 * not a calibrated microphone noise-floor reading. CRC remains mandatory. */
export function decodeHexFskSamplesWithMetrics(samples: Float32Array, sampleRate: number): HexFskDecode[] {
  const symbolSamples = Math.round(sampleRate * FSK_SYMBOL_SECONDS)
  const found = new Map<string, { result: HexFskDecode; position: number }>()
  for (let phase = 0; phase < symbolSamples; phase += Math.max(1, Math.floor(symbolSamples / 16))) {
    const count = Math.floor((samples.length - phase) / symbolSamples)
    if (count < SYNC_SYMBOLS + PREAMBLE.length * 2 + 13 * 2) continue
    const symbols = new Uint8Array(count)
    for (let index = 0; index < count; index += 1) {
      const start = phase + index * symbolSamples
      let best = 0, highest = -1
      for (let tone = 0; tone < 16; tone += 1) {
        const value = energy(samples, start, symbolSamples, HEX_FSK_TONES_HZ[tone], sampleRate)
        if (value > highest) { highest = value; best = tone }
      }
      symbols[index] = best
    }
    for (let offset = SYNC_SYMBOLS; offset + PREAMBLE.length * 2 + 13 * 2 <= count; offset += 1) {
      if (PREAMBLE.some((value, index) => symbols[offset + index * 2] !== value >>> 4 || symbols[offset + index * 2 + 1] !== (value & 15))) continue
      const syncStart = phase + (offset - SYNC_SYMBOLS) * symbolSamples, syncLength = SYNC_SYMBOLS * symbolSamples
      const syncEnergy = energy(samples, syncStart, syncLength, HEX_FSK_SYNC_HZ, sampleRate)
      let dataEnergy = 0
      for (const frequency of HEX_FSK_TONES_HZ) dataEnergy = Math.max(dataEnergy, energy(samples, syncStart, syncLength, frequency, sampleRate))
      if (syncEnergy <= dataEnergy * 3 || syncEnergy <= 0) continue
      const bodyStart = offset + PREAMBLE.length * 2
      const byteAt = (index: number) => (symbols[bodyStart + index * 2] << 4) | symbols[bodyStart + index * 2 + 1]
      const compact = byteAt(0) === COMPACT_MAGIC, payloadLength = compact ? 0 : byteAt(10)
      const bodyLength = compact ? COMPACT_BYTES : 13 + payloadLength
      if (payloadLength > CONTROL_MAX_PAYLOAD || bodyStart + bodyLength * 2 > count) continue
      const body = new Uint8Array(bodyLength)
      for (let index = 0; index < bodyLength; index += 1) body[index] = byteAt(index)
      const packet = compact ? unpackCompactControlPacket(body) : unpackControlPacket(body)
      if (!packet) continue
      const sorted = Array.from({ length: bodyLength * 2 }, (_, index) => {
        const at = bodyStart + index
        return fittedToneSnrDb(samples, phase + at * symbolSamples, symbolSamples, HEX_FSK_TONES_HZ[symbols[at]], sampleRate)
      }).sort((left, right) => left - right)
      const estimatedSnrDb = sorted[Math.floor(sorted.length * 0.2)] || 0
      const key = `${packet.transferId}:${packet.sequence}:${packet.type}`
      if (!found.has(key) || estimatedSnrDb > found.get(key)!.result.estimatedSnrDb) found.set(key, { result: { packet, estimatedSnrDb }, position: syncStart })
    }
  }
  return [...found.values()].sort((left, right) => left.position - right.position).map(item => item.result)
}
export function decodeHexFskSamples(samples: Float32Array, sampleRate: number): ControlPacket[] { return decodeHexFskSamplesWithMetrics(samples, sampleRate).map(item => item.packet) }
