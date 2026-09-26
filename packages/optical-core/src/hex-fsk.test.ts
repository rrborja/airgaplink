import { readFileSync } from 'node:fs'
import { ReedSolomonErasure } from '@digitaldefiance/reed-solomon-erasure.wasm/browser'
import { ControlType, packControlPacket, unpackControlPacket, type ControlPacket } from './control.ts'
import { AcousticFragmentReassembler, DenseHandshakeReassembler, fragmentDenseHandshakeResponse, fragmentHandshakeMessage } from './acoustic-fragment.ts'
import { AUDIO_MODE_SELECT_MAGIC, acousticFallbackDecision, chooseAdaptiveAudioMode, decodeAudioModeSelect, encodeAudioModeSelect, nextSaferAcousticMode, responseToneCount, runtimeToneAllowed, runtimeToneCount, selectedAcousticModeMatches } from './audio-mode.ts'
import { HANDSHAKE_CAPABILITY_ADAPTIVE_AUDIO, HANDSHAKE_CAPABILITY_HEX_FSK, HANDSHAKE_CAPABILITY_OCTAL_CONTROL, HANDSHAKE_CAPABILITY_OCTAL_FSK, HANDSHAKE_CAPABILITY_RESPONSE_PARITY, HANDSHAKE_CAPABILITY_DENSE_RESPONSE, decodeHandshakeResponse, decodeKeyConfirm, deriveHandshakeMaterial, encodeHandshakeResponse, encodeKeyConfirmAudioMode, keyConfirmAudioMode, makeOffer, makeResponse, readyConfirmFast } from './handshake.ts'
import { generateEphemeralKeyPair } from './crypto.ts'
import { ReedSolomonBlockCodec } from './fec.ts'
import { decodeHexFskSamples, decodeHexFskSamplesWithMetrics, encodeHexCompactFskPacket, encodeHexFskHandshakePacket, encodeHexFskPacket, HEX_FSK_TONES_HZ } from './hex-fsk.ts'
import { encodeOctalFskPacket, decodeOctalFskSamples } from './octal-fsk.ts'
import { FastReadyAssembler, fastReadyPackets } from './ready-control.ts'
import { DEBUG_PROFILE, decodeOpticalCells, encodeOpticalFrame } from './index.ts'

function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message) }
function noise(samples: Float32Array, amplitude: number, delay = 0) {
  const result = samples.slice(); let seed = 0x12345678
  for (let index = 0; index < result.length; index += 1) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    result[index] += amplitude * ((seed / 0xffffffff) * 2 - 1) + (index >= delay && delay ? 0.18 * samples[index - delay] : 0)
  }
  return result
}
const probe: ControlPacket = { type: ControlType.ACOUSTIC_PROBE, transferId: 0x01234567, sequence: 22, payload: Uint8Array.of(0x7a, 1, 16) }
assert(HEX_FSK_TONES_HZ.length === 16 && HEX_FSK_TONES_HZ.every((tone, index) => index === 0 || tone - HEX_FSK_TONES_HZ[index - 1] === 250), '16-FSK tone spacing changed')
const allTones: ControlPacket = { ...probe, sequence: 24, payload: Uint8Array.of(0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef) }
assert(decodeHexFskSamples(encodeHexFskPacket(allTones), 48000)[0]?.payload.every((value, index) => value === allTones.payload[index]), '16-FSK failed to discriminate every tone in one packet')
for (const sampleRate of [44100, 48000]) {
  const clean = encodeHexFskPacket(probe, sampleRate)
  const shifted = new Float32Array(clean.length + Math.round(sampleRate * 0.011)); shifted.set(clean, shifted.length - clean.length)
  for (const samples of [clean, shifted, noise(clean, 0.03, Math.round(sampleRate * 0.023))]) {
    const decoded = decodeHexFskSamplesWithMetrics(samples, sampleRate)
    assert(decoded.length === 1 && decoded[0].packet.transferId === probe.transferId && decoded[0].packet.sequence === probe.sequence && decoded[0].packet.payload[2] === 16, '16-FSK physical probe failed with offset, noise, or echo')
    assert(decoded[0].estimatedSnrDb >= 9, 'Clean/high-quality 16-FSK probe did not pass conservative SNR threshold')
  }
  const damaged = clean.slice(); damaged.fill(0, Math.floor(damaged.length * 0.3), Math.floor(damaged.length * 0.7))
  assert(decodeHexFskSamples(damaged, sampleRate).length === 0, 'Damaged 16-FSK packet passed physical CRC')
}
const octalProbe = { ...probe, sequence: 23, payload: Uint8Array.of(0x7a, 0, 8) }
assert(decodeOctalFskSamples(encodeOctalFskPacket(octalProbe), 48000).length === 1, '8-FSK compatibility probe failed')
assert(!decodeOctalFskSamples(encodeHexFskPacket(probe), 48000).length, '16-FSK was mistaken for a CRC-valid 8-FSK packet')
const caps = HANDSHAKE_CAPABILITY_OCTAL_FSK | HANDSHAKE_CAPABILITY_OCTAL_CONTROL | HANDSHAKE_CAPABILITY_ADAPTIVE_AUDIO | HANDSHAKE_CAPABILITY_HEX_FSK | HANDSHAKE_CAPABILITY_DENSE_RESPONSE | HANDSHAKE_CAPABILITY_RESPONSE_PARITY
assert(chooseAdaptiveAudioMode(caps, { octalDecoded: true, hexDecoded: true, estimatedSnrDb: 12 }) === 16, 'Good measured channel did not select 16-FSK')
for (const quality of [{ octalDecoded: true, hexDecoded: false, estimatedSnrDb: 20 }, { octalDecoded: false, hexDecoded: true, estimatedSnrDb: 20 }, { octalDecoded: true, hexDecoded: true, estimatedSnrDb: 7 }]) assert(chooseAdaptiveAudioMode(caps, quality) === 8, 'Poor/lossy probe did not fall back to 8-FSK')
assert(nextSaferAcousticMode(32) === 16 && nextSaferAcousticMode(16) === 8 && nextSaferAcousticMode(8) === null, 'OFDM → 16-FSK → 8-FSK fallback ladder changed')
assert(acousticFallbackDecision(32, 8000, 8000, 0) === 16 && acousticFallbackDecision(16, 8000, 8000, 0) === 8 && acousticFallbackDecision(8, 8000, 8000, 0) === null, 'No-packet fallback ladder failed')
assert(acousticFallbackDecision(16, 19000, 6000, 7) === null && acousticFallbackDecision(16, 23000, 6000, 7) === 8 && acousticFallbackDecision(16, 23000, 1000, 7) === null, 'Retry window did not distinguish a stalled response from an active one')
assert(selectedAcousticModeMatches(16, caps, 16) && !selectedAcousticModeMatches(16, caps & ~HANDSHAKE_CAPABILITY_HEX_FSK, 8) && !selectedAcousticModeMatches(16, caps, 8), 'Selected 16-FSK mode mismatch was accepted')
assert(selectedAcousticModeMatches(8, caps & ~(HANDSHAKE_CAPABILITY_ADAPTIVE_AUDIO | HANDSHAKE_CAPABILITY_HEX_FSK), 8) && !selectedAcousticModeMatches(undefined, caps, 16), 'Legacy 8-FSK fallback or unrequested adaptive response changed')

const sender = generateEphemeralKeyPair(), receiver = generateEphemeralKeyPair(), offer = makeOffer(sender, caps)
const modeFrame = encodeAudioModeSelect(offer.sessionId, 16, 3, 13)
const selected = decodeAudioModeSelect(modeFrame)
assert(modeFrame.length === 23 && modeFrame.slice(0, 4).every((value, index) => value === AUDIO_MODE_SELECT_MAGIC[index]) && selected?.mode === 16 && selected.estimatedSnrDb === 13, 'Optical mode selection failed binary round trip')
const opticalSelection = decodeOpticalCells(encodeOpticalFrame(modeFrame, 11, 0, DEBUG_PROFILE).cells, DEBUG_PROFILE)
assert(opticalSelection.ok && decodeAudioModeSelect(opticalSelection.payload)?.mode === 16, 'Optical mode selection failed frame transport')
const wrongSession = offer.sessionId.slice(); wrongSession[15] ^= 1
assert(decodeAudioModeSelect(encodeAudioModeSelect(wrongSession, 8, 1, 0))?.sessionId[15] !== offer.sessionId[15], 'Mode selection was not session-scoped')
const invalidMode = modeFrame.slice(); invalidMode[20] = 64
assert(!decodeAudioModeSelect(invalidMode), 'Unknown acoustic mode was accepted')
const response = makeResponse(offer, receiver, 1, caps)
const senderMaterial = deriveHandshakeMaterial(offer, response, sender.privateKey)
assert(responseToneCount(response.capabilities, 1) === 16 && runtimeToneCount(response.capabilities, 16) === 16 && runtimeToneAllowed(response.capabilities, 16) && !runtimeToneAllowed(response.capabilities, 8), '16-FSK mode was not locked')
let mismatchAccepted = false
try { runtimeToneCount(response.capabilities, 8); mismatchAccepted = true } catch { /* expected */ }
assert(!mismatchAccepted, '16-FSK response was silently downgraded to 8-FSK')
const alternateResponse = { ...response, capabilities: response.capabilities & ~HANDSHAKE_CAPABILITY_HEX_FSK }
try { deriveHandshakeMaterial(offer, alternateResponse, sender.privateKey); mismatchAccepted = true } catch { /* expected */ }
assert(!mismatchAccepted, 'Transcript accepted a changed acoustic mode')
assert(keyConfirmAudioMode(senderMaterial.keys.handshakeConfirmKey, senderMaterial.transcriptHash, 16).some((byte, index) => byte !== keyConfirmAudioMode(senderMaterial.keys.handshakeConfirmKey, senderMaterial.transcriptHash, 8)[index]), 'Key confirmation did not bind selected mode')
const confirm16 = decodeKeyConfirm(encodeKeyConfirmAudioMode(offer.sessionId, 16, keyConfirmAudioMode(senderMaterial.keys.handshakeConfirmKey, senderMaterial.transcriptHash, 16)))
assert(confirm16?.toneCount === 16 && confirm16.confirmation.every((value, index) => value === keyConfirmAudioMode(senderMaterial.keys.handshakeConfirmKey, senderMaterial.transcriptHash, 16)[index]), '16-FSK optical key confirmation failed')

const message = encodeHandshakeResponse(response), transferId = new DataView(offer.sessionId.buffer).getUint32(0)
const wasm = readFileSync(new URL(import.meta.resolve('@digitaldefiance/reed-solomon-erasure.wasm/wasm')))
const codec = () => new ReedSolomonBlockCodec(ReedSolomonErasure.fromBytes(wasm))
const fragments = fragmentDenseHandshakeResponse(transferId, 200, offer.sessionId, message, codec())
const assembler = new DenseHandshakeReassembler(offer.sessionId, codec)
let completed: ReturnType<typeof assembler.add> = null
for (const [index, packet] of fragments.entries()) {
  if (index === 4) continue // One acoustic erasure should be repaired without replay.
  const sound = encodeHexFskHandshakePacket(packet)
  const decoded = decodeHexFskSamples(sound, 48000)
  assert(decoded.length === 1, `16-FSK response fragment ${index} failed physical decode`)
  completed = assembler.add(decoded[0]) || completed
}
assert(completed && completed.message.every((value, index) => value === message[index]), '16-FSK response did not survive a lost fragment')
const parsed = decodeHandshakeResponse(completed.message)
assert(parsed && deriveHandshakeMaterial(offer, parsed, sender.privateKey).sas === deriveHandshakeMaterial(offer, response, receiver.privateKey, 'receiver').sas, 'Recovered 16-FSK response failed transcript binding')
const readyMac = readyConfirmFast(senderMaterial.keys.handshakeConfirmKey, senderMaterial.transcriptHash)
const ready = fastReadyPackets(transferId, 300, readyMac), readyAssembler = new FastReadyAssembler()
const decodedReady = ready.map(packet => decodeHexFskSamples(encodeHexFskPacket(packet), 48000)[0])
assert(decodedReady.every(Boolean) && !readyAssembler.add(decodedReady[1], transferId) && readyAssembler.add(decodedReady[0], transferId)?.every((value, index) => value === readyMac[index]), '16-FSK READY failed physical decode or authenticated assembly')
assert(readyMac.some((value, index) => value !== readyConfirmFast(senderMaterial.keys.handshakeConfirmKey, new Uint8Array(senderMaterial.transcriptHash.length))[index]), '16-FSK READY was not transcript-bound')
const compact = { type: ControlType.BLOCK_STATUS, transferId, sequence: 400, payload: Uint8Array.of(0, 0, 1, 0) }
assert(decodeHexFskSamples(encodeHexCompactFskPacket(compact), 48000).length === 1, '16-FSK compact runtime ACK failed')
const ordinary = fragmentHandshakeMessage(transferId, 500, transferId, 1, message)
const legacy = new AcousticFragmentReassembler()
let legacyMessage: Uint8Array | null = null
for (const packet of ordinary) legacyMessage = legacy.add(unpackControlPacket(packControlPacket(packet))!)?.message || legacyMessage
assert(legacyMessage && legacyMessage.length === 108, 'Legacy acoustic response compatibility regressed')
const hexSeconds = fragments.reduce((sum, packet) => sum + encodeHexFskHandshakePacket(packet).length / 48000 + 0.015, 0)
assert(hexSeconds < 15, '16-FSK did not materially improve response airtime')
console.log(JSON.stringify({ result: 'ok', responsePackets: fragments.length, responseAirtimeSeconds: Number(hexSeconds.toFixed(2)), highBandSnrThresholdDb: 9 }))
