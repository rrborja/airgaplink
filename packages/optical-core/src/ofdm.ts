import { CONTROL_MAX_PAYLOAD, ControlType, packCompactControlPacket, packControlPacket, unpackCompactControlPacket, unpackControlPacket, type ControlPacket } from './control.ts'

/** Experimental differential-BPSK OFDM control modem. Thirty-two orthogonal
 * carriers share each 16 ms useful symbol. A 4 ms cyclic prefix tolerates
 * modest room echoes; one known training symbol locates the packet. The
 * existing CRC16 packet body and compact ACK layout are unchanged. */
export const OFDM_CARRIERS = 32
export const OFDM_USEFUL_SECONDS = 0.016
export const OFDM_PREFIX_SECONDS = 0.004
const FIRST_BIN = 18
const COMPACT_MAGIC = 0xc7
const TRAINING_SIGNS: number[] = Array.from({ length: OFDM_CARRIERS }, (_, index) => ((Math.imul(index + 1, 0x9e3779b1) >>> 27) & 1) ? -1 : 1)
const cache = new Map<number, { useful: number; prefix: number; symbol: number; cos: Float32Array[]; sin: Float32Array[]; training: Float32Array; trainingEnergy: number }>()

function plan(sampleRate: number) {
  if (!Number.isFinite(sampleRate) || sampleRate < 32000 || sampleRate > 96000) throw new Error('Unsupported OFDM sample rate')
  const rate = Math.round(sampleRate), existing = cache.get(rate)
  if (existing) return existing
  const useful = Math.round(rate * OFDM_USEFUL_SECONDS), prefix = Math.round(rate * OFDM_PREFIX_SECONDS), symbol = useful + prefix
  const cos: Float32Array[] = [], sin: Float32Array[] = []
  for (let carrier = 0; carrier < OFDM_CARRIERS; carrier += 1) {
    const real = new Float32Array(useful), imaginary = new Float32Array(useful)
    for (let sample = 0; sample < useful; sample += 1) {
      const phase = 2 * Math.PI * (FIRST_BIN + carrier) * sample / useful
      real[sample] = Math.cos(phase); imaginary[sample] = Math.sin(phase)
    }
    cos.push(real); sin.push(imaginary)
  }
  const training = renderUseful(TRAINING_SIGNS, { useful, cos })
  let trainingEnergy = 0
  for (const value of training) trainingEnergy += value * value
  const result = { useful, prefix, symbol, cos, sin, training, trainingEnergy }
  cache.set(rate, result)
  return result
}

function renderUseful(signs: number[], config: { useful: number; cos: Float32Array[] }) {
  const result = new Float32Array(config.useful)
  for (let carrier = 0; carrier < OFDM_CARRIERS; carrier += 1) {
    const basis = config.cos[carrier], sign = signs[carrier]
    for (let sample = 0; sample < result.length; sample += 1) result[sample] += sign * basis[sample]
  }
  let peak = 0
  for (const value of result) peak = Math.max(peak, Math.abs(value))
  const scale = 0.65 / Math.max(peak, 1)
  for (let sample = 0; sample < result.length; sample += 1) result[sample] *= scale
  return result
}

function encodeBody(body: Uint8Array, sampleRate: number) {
  const config = plan(sampleRate), dataSymbols = Math.ceil(body.length * 8 / OFDM_CARRIERS)
  const edge = Math.round(sampleRate * 0.008)
  const output = new Float32Array(edge * 2 + (dataSymbols + 1) * config.symbol)
  let signs = TRAINING_SIGNS.slice()
  for (let symbolIndex = -1; symbolIndex < dataSymbols; symbolIndex += 1) {
    if (symbolIndex >= 0) for (let carrier = 0; carrier < OFDM_CARRIERS; carrier += 1) {
      const bitIndex = symbolIndex * OFDM_CARRIERS + carrier
      const bit = bitIndex < body.length * 8 ? (body[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1 : 0
      if (bit) signs[carrier] = -signs[carrier]
    }
    const useful = symbolIndex < 0 ? config.training : renderUseful(signs, config)
    const start = edge + (symbolIndex + 1) * config.symbol
    output.set(useful.subarray(config.useful - config.prefix), start)
    output.set(useful, start + config.prefix)
  }
  return output
}

export function encodeOfdmPacket(packet: ControlPacket, sampleRate = 48000) { return encodeBody(packControlPacket(packet), sampleRate) }
export function encodeOfdmCompactPacket(packet: ControlPacket, sampleRate = 48000) { return encodeBody(packCompactControlPacket(packet), sampleRate) }
export function encodeOfdmHandshakePacket(packet: ControlPacket, sampleRate = 48000) {
  if (packet.type !== ControlType.HANDSHAKE_FRAGMENT && packet.type !== ControlType.HANDSHAKE_DENSE_FRAGMENT) throw new Error('OFDM handshake encoder requires a fragment')
  return encodeOfdmPacket(packet, sampleRate)
}

function trainingScore(samples: Float32Array, start: number, config: ReturnType<typeof plan>) {
  if (start < 0 || start + config.useful > samples.length) return 0
  let dot = 0, energy = 0
  for (let sample = 0; sample < config.useful; sample += 1) {
    const value = samples[start + sample]
    dot += value * config.training[sample]; energy += value * value
  }
  return dot * dot / Math.max(config.trainingEnergy * energy, 1e-12)
}

function carriers(samples: Float32Array, start: number, config: ReturnType<typeof plan>) {
  const real = new Float32Array(OFDM_CARRIERS), imaginary = new Float32Array(OFDM_CARRIERS)
  for (let carrier = 0; carrier < OFDM_CARRIERS; carrier += 1) {
    const cosine = config.cos[carrier], sine = config.sin[carrier]
    let re = 0, im = 0
    for (let sample = 0; sample < config.useful; sample += 1) {
      const value = samples[start + sample]
      re += value * cosine[sample]; im -= value * sine[sample]
    }
    real[carrier] = re; imaginary[carrier] = im
  }
  return { real, imaginary }
}

export interface OfdmDecode { packet: ControlPacket; estimatedSnrDb: number }
function decodeAt(samples: Float32Array, trainingStart: number, config: ReturnType<typeof plan>): OfdmDecode | null {
  const bytes = new Uint8Array(13 + CONTROL_MAX_PAYLOAD)
  let previous = carriers(samples, trainingStart, config), bitIndex = 0, margin = 0, comparisons = 0
  for (let symbolIndex = 0; symbolIndex < Math.ceil(bytes.length * 8 / OFDM_CARRIERS); symbolIndex += 1) {
    const start = trainingStart + (symbolIndex + 1) * config.symbol
    if (start + config.useful > samples.length) break
    const current = carriers(samples, start, config)
    for (let carrier = 0; carrier < OFDM_CARRIERS && bitIndex < bytes.length * 8; carrier += 1) {
      const re = current.real[carrier] * previous.real[carrier] + current.imaginary[carrier] * previous.imaginary[carrier]
      const im = current.imaginary[carrier] * previous.real[carrier] - current.real[carrier] * previous.imaginary[carrier]
      if (re < 0) bytes[bitIndex >>> 3] |= 1 << (7 - (bitIndex & 7))
      margin += Math.abs(re) / Math.max(Math.abs(im), 1e-6); comparisons += 1; bitIndex += 1
    }
    previous = current
    const bodyLength = bytes[0] === COMPACT_MAGIC ? 14 : 13 + bytes[10]
    if (bitIndex >= 88 && bodyLength >= 13 && bodyLength <= bytes.length && bitIndex >= bodyLength * 8) {
      const body = bytes.subarray(0, bodyLength), packet = bytes[0] === COMPACT_MAGIC ? unpackCompactControlPacket(body) : unpackControlPacket(body)
      if (packet) return { packet, estimatedSnrDb: 20 * Math.log10(Math.max(1, margin / comparisons)) }
      return null
    }
  }
  return null
}

/** Correlation finds the training symbol; only CRC-valid control packets are
 * returned. This decoder does not grant any handshake authority by itself. */
export function decodeOfdmSamplesWithMetrics(samples: Float32Array, sampleRate: number): OfdmDecode[] {
  const config = plan(sampleRate), found = new Map<string, { result: OfdmDecode; start: number }>()
  const max = samples.length - config.useful - 4 * config.symbol
  if (max < 0) return []
  // The multicarrier autocorrelation peak is narrow; 4-sample coarse steps
  // avoid skipping a shifted packet altogether.
  const stride = 4
  for (let approximate = 0; approximate <= max; approximate += stride) {
    if (trainingScore(samples, approximate, config) < 0.35) continue
    let bestStart = approximate, bestScore = 0
    for (let start = Math.max(0, approximate - stride); start <= Math.min(max, approximate + stride); start += 1) {
      const score = trainingScore(samples, start, config)
      if (score > bestScore) { bestScore = score; bestStart = start }
    }
    if (bestScore < 0.45) continue
    let result: OfdmDecode | null = null
    // A room echo can move the correlation maximum several samples while the
    // cyclic prefix keeps the actual symbol boundary decodable.
    for (let offset = 0; offset <= Math.min(config.prefix, stride * 2) && !result; offset += 1) {
      result = decodeAt(samples, bestStart + offset, config)
      if (!result && offset) result = decodeAt(samples, bestStart - offset, config)
    }
    if (!result) continue
    const key = `${result.packet.transferId}:${result.packet.type}:${result.packet.sequence}`
    if (!found.has(key) || result.estimatedSnrDb > found.get(key)!.result.estimatedSnrDb) found.set(key, { result, start: bestStart })
    approximate = bestStart + config.symbol * 3
  }
  return [...found.values()].sort((a, b) => a.start - b.start).map(item => item.result)
}
export function decodeOfdmSamples(samples: Float32Array, sampleRate: number) { return decodeOfdmSamplesWithMetrics(samples, sampleRate).map(item => item.packet) }
