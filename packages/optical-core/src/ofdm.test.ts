import { readFileSync } from 'node:fs'
import { ReedSolomonErasure } from '@digitaldefiance/reed-solomon-erasure.wasm/browser'
import { ControlType, type ControlPacket } from './control.ts'
import { DenseHandshakeReassembler, fragmentDenseHandshakeResponse } from './acoustic-fragment.ts'
import { chooseAdaptiveAudioMode, decodeAudioModeSelect, encodeAudioModeSelect, responseToneCount, runtimeToneCount, selectedAcousticModeMatches } from './audio-mode.ts'
import { generateEphemeralKeyPair } from './crypto.ts'
import { ReedSolomonBlockCodec } from './fec.ts'
import { fastReadyPackets, FastReadyAssembler } from './ready-control.ts'
import { HANDSHAKE_CAPABILITY_ADAPTIVE_AUDIO, HANDSHAKE_CAPABILITY_DENSE_RESPONSE, HANDSHAKE_CAPABILITY_HEX_FSK, HANDSHAKE_CAPABILITY_OFDM, HANDSHAKE_CAPABILITY_RESPONSE_PARITY, decodeKeyConfirm, deriveHandshakeMaterial, encodeHandshakeResponse, encodeKeyConfirmAudioMode, keyConfirmAudioMode, makeOffer, makeResponse, readyConfirmFast } from './handshake.ts'
import { decodeOfdmSamplesWithMetrics, encodeOfdmCompactPacket, encodeOfdmHandshakePacket, encodeOfdmPacket, OFDM_CARRIERS } from './ofdm.ts'

function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message) }
function impair(samples: Float32Array, sampleRate: number) {
  const delay = Math.round(sampleRate * 0.0015), result = new Float32Array(samples.length + 213)
  let seed = 0x12345678
  for (let index = 0; index < samples.length; index += 1) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    result[index + 213] = samples[index] * 0.8 + (index >= delay ? samples[index - delay] * 0.12 : 0) + ((seed / 0xffffffff) * 2 - 1) * 0.008
  }
  return result
}
const packet: ControlPacket = { type: ControlType.ACOUSTIC_PROBE, transferId: 0x12345678, sequence: 41, payload: Uint8Array.of(0x7a, 2, 32) }
assert(OFDM_CARRIERS === 32, 'OFDM carrier count changed')
for (const rate of [44100, 48000]) for (const sound of [encodeOfdmPacket(packet, rate), impair(encodeOfdmPacket(packet, rate), rate)]) {
  const decoded = decodeOfdmSamplesWithMetrics(sound, rate)
  assert(decoded.length === 1 && decoded[0].packet.transferId === packet.transferId && decoded[0].packet.payload[2] === 32, `OFDM probe failed at ${rate} Hz`)
  assert(decoded[0].estimatedSnrDb >= 12, 'Clean OFDM probe lacked phase margin')
}
const damaged = encodeOfdmPacket(packet), midpoint = damaged.length >>> 1
damaged.fill(0, midpoint - 1800, midpoint + 1800)
assert(!decodeOfdmSamplesWithMetrics(damaged, 48000).length, 'Corrupted OFDM packet passed CRC')
const compact: ControlPacket = { type: ControlType.BLOCK_STATUS, transferId: packet.transferId, sequence: 42, payload: Uint8Array.of(0, 0, 4, 0) }
assert(decodeOfdmSamplesWithMetrics(encodeOfdmCompactPacket(compact), 48000)[0]?.packet.type === ControlType.BLOCK_STATUS, 'OFDM compact ACK failed')
const first = encodeOfdmPacket(packet), second = encodeOfdmCompactPacket(compact), stream = new Float32Array(first.length * 2 + second.length + 800)
stream.set(first, 173); stream.set(second, first.length + 400); stream.set(first, first.length + second.length + 600)
assert(decodeOfdmSamplesWithMetrics(stream, 48000).length === 2, 'OFDM duplicate, out-of-order stream, or packet boundary handling failed')
const caps = HANDSHAKE_CAPABILITY_ADAPTIVE_AUDIO | HANDSHAKE_CAPABILITY_HEX_FSK | HANDSHAKE_CAPABILITY_OFDM | HANDSHAKE_CAPABILITY_DENSE_RESPONSE | HANDSHAKE_CAPABILITY_RESPONSE_PARITY
assert(chooseAdaptiveAudioMode(caps, { octalDecoded: true, hexDecoded: true, estimatedSnrDb: 14, ofdmDecoded: true, ofdmSnrDb: 16 }) === 32, 'Good OFDM channel not selected')
assert(chooseAdaptiveAudioMode(caps, { octalDecoded: true, hexDecoded: true, estimatedSnrDb: 14, ofdmDecoded: false }) === 16, 'OFDM packet loss did not fall back to 16-FSK')
assert(chooseAdaptiveAudioMode(caps, { octalDecoded: true, hexDecoded: false, estimatedSnrDb: 0, ofdmDecoded: false }) === 8, 'High-band packet loss did not fall back to 8-FSK')
assert(responseToneCount(caps & ~HANDSHAKE_CAPABILITY_OFDM, 1) === 16 && selectedAcousticModeMatches(16, caps & ~HANDSHAKE_CAPABILITY_OFDM, 16), 'Peer without OFDM capability lost 16-FSK compatibility')
const sender = generateEphemeralKeyPair(), receiver = generateEphemeralKeyPair(), offer = makeOffer(sender, caps), response = makeResponse(offer, receiver, 1, caps)
const selection = decodeAudioModeSelect(encodeAudioModeSelect(offer.sessionId, 32, 7, 18))
assert(selection?.mode === 32 && selection.probeMask === 7, 'OFDM optical selection failed')
assert(responseToneCount(response.capabilities, 1) === 32 && runtimeToneCount(response.capabilities, 32) === 32 && selectedAcousticModeMatches(32, caps, 32), 'Authenticated OFDM mode not locked')
let mismatchAccepted = false
try { runtimeToneCount(caps, 16); mismatchAccepted = true } catch { /* expected */ }
assert(!mismatchAccepted && !selectedAcousticModeMatches(32, caps & ~HANDSHAKE_CAPABILITY_OFDM, 32), 'OFDM downgrade or mismatch accepted')
const senderMaterial = deriveHandshakeMaterial(offer, response, sender.privateKey), receiverMaterial = deriveHandshakeMaterial(offer, response, receiver.privateKey, 'receiver')
assert(senderMaterial.sas === receiverMaterial.sas, 'OFDM selection broke SAS agreement')
const confirm = decodeKeyConfirm(encodeKeyConfirmAudioMode(offer.sessionId, 32, keyConfirmAudioMode(senderMaterial.keys.handshakeConfirmKey, senderMaterial.transcriptHash, 32)))
assert(confirm?.toneCount === 32 && confirm.confirmation.every((value, index) => value === keyConfirmAudioMode(receiverMaterial.keys.handshakeConfirmKey, receiverMaterial.transcriptHash, 32)[index]), 'OFDM key confirmation failed')
const readyMac = readyConfirmFast(senderMaterial.keys.handshakeConfirmKey, senderMaterial.transcriptHash)
const readyPackets = fastReadyPackets(packet.transferId, 50, readyMac), readyAssembler = new FastReadyAssembler()
const firstReady = decodeOfdmSamplesWithMetrics(encodeOfdmPacket(readyPackets[0]), 48000)[0]?.packet
const secondReady = decodeOfdmSamplesWithMetrics(encodeOfdmPacket(readyPackets[1]), 48000)[0]?.packet
assert(firstReady && secondReady && !readyAssembler.add(secondReady, packet.transferId) && readyAssembler.add(firstReady, packet.transferId)?.every((value, index) => value === readyMac[index]), 'OFDM authenticated READY parts did not survive reverse arrival')
const modified = { ...response, capabilities: response.capabilities & ~HANDSHAKE_CAPABILITY_OFDM }
try { deriveHandshakeMaterial(offer, modified, sender.privateKey); mismatchAccepted = true } catch { /* expected */ }
assert(!mismatchAccepted, 'OFDM capability was not transcript-bound')
const wasm = readFileSync(new URL(import.meta.resolve('@digitaldefiance/reed-solomon-erasure.wasm/wasm')))
const codec = () => new ReedSolomonBlockCodec(ReedSolomonErasure.fromBytes(wasm))
const message = encodeHandshakeResponse(response), transferId = new DataView(offer.sessionId.buffer, offer.sessionId.byteOffset, 4).getUint32(0), fragments = fragmentDenseHandshakeResponse(transferId, 100, offer.sessionId, message, codec())
const assembler = new DenseHandshakeReassembler(offer.sessionId, codec)
let assembled: ReturnType<typeof assembler.add> = null
let airtime = 0
for (const [index, fragment] of fragments.entries()) {
  const sound = encodeOfdmHandshakePacket(fragment)
  airtime += sound.length / 48000 + 0.015
  if (index === 4) continue
  const decoded = decodeOfdmSamplesWithMetrics(sound, 48000)
  assert(decoded.length === 1, `OFDM response fragment ${index} failed CRC decode`)
  assembled = assembler.add(decoded[0].packet) || assembled
}
assert(assembled && assembled.message.every((value, index) => value === message[index]), 'OFDM parity recovery failed')
assert(airtime < 5, 'OFDM response airtime did not materially improve')
console.log(JSON.stringify({ result: 'ok', fragments: fragments.length, responseAirtimeSeconds: Number(airtime.toFixed(2)) }))
