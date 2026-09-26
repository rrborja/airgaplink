import { readFileSync } from 'node:fs'
import { ReedSolomonErasure } from '@digitaldefiance/reed-solomon-erasure.wasm/browser'
import { AcousticFragmentReassembler, DenseHandshakeReassembler, fragmentDenseHandshakeResponse, fragmentHandshakeMessage, isFreshHandshakeNackRequest, parseDenseHandshakeFragment, selectHandshakeNackRetransmissions } from './acoustic-fragment.ts'
import { packControlPacket, unpackControlPacket } from './control.ts'
import { ReedSolomonBlockCodec } from './fec.ts'
import { DEBUG_PROFILE, HANDSHAKE_CAPABILITY_DENSE_RESPONSE, HANDSHAKE_CAPABILITY_RESPONSE_PARITY, HANDSHAKE_NACK_DENSE, HANDSHAKE_NACK_LEGACY, decodeHandshakeNack, decodeHandshakeOffer, decodeHandshakeResponse, decodeKeyConfirm, decodeOpticalCells, decodeReadyConfirm, deriveHandshakeMaterial, encodeHandshakeNack, encodeHandshakeResponse, encodeOpticalFrame, generateEphemeralKeyPair, makeOffer, makeResponse } from './index.ts'
import { decodeOctalFskSamples, encodeOctalFskHandshakePacket } from './octal-fsk.ts'

const wasm = readFileSync(new URL(import.meta.resolve('@digitaldefiance/reed-solomon-erasure.wasm/wasm')))
const codec = () => new ReedSolomonBlockCodec(ReedSolomonErasure.fromBytes(wasm))
const sender = generateEphemeralKeyPair(), receiver = generateEphemeralKeyPair()
const offer = makeOffer(sender, HANDSHAKE_CAPABILITY_DENSE_RESPONSE | HANDSHAKE_CAPABILITY_RESPONSE_PARITY)
const response = makeResponse(offer, receiver, 2, offer.capabilities)
const message = encodeHandshakeResponse(response)
const transferId = new DataView(offer.sessionId.buffer, offer.sessionId.byteOffset, 4).getUint32(0)
if (message.length !== 108) throw new Error('Unexpected response length')
const dense = fragmentDenseHandshakeResponse(transferId, 100, offer.sessionId, message, codec())
if (dense.length !== 14 || dense.some(packet => packet.payload.length !== 12)) throw new Error('Dense response did not use 12 data and two parity packets')
const acousticDecoded = decodeOctalFskSamples(encodeOctalFskHandshakePacket(dense[0]), 48000)
if (acousticDecoded.length !== 1 || acousticDecoded[0].type !== dense[0].type || acousticDecoded[0].payload.some((value, index) => value !== dense[0].payload[index])) throw new Error('Dense response failed eight-tone physical decode')
for (const missing of [[0], [3], [11], [2, 9]]) {
  const assembler = new DenseHandshakeReassembler(offer.sessionId, codec)
  let result: ReturnType<typeof assembler.add> = null
  for (const packet of dense.filter((_, index) => !missing.includes(index)).reverse()) {
    const physical = unpackControlPacket(packControlPacket(packet))
    if (!physical) throw new Error('Dense physical CRC round trip failed')
    result = assembler.add(physical) || result
    assembler.add(physical) // duplicates must be harmless
  }
  if (!result || result.recovered < missing.length || result.recovered > 2 || result.message.some((value, index) => value !== message[index])) throw new Error(`Dense response parity recovery failed: ${missing.join(',')} / ${result?.recovered}`)
  const parsed = decodeHandshakeResponse(result.message)
  if (!parsed || deriveHandshakeMaterial(offer, parsed, sender.privateKey).sas !== deriveHandshakeMaterial(offer, response, receiver.privateKey, 'receiver').sas) throw new Error('Recovered response failed cryptographic transcript binding')
}
const incomplete = new DenseHandshakeReassembler(offer.sessionId, codec)
let unexpected = null
for (const packet of dense.filter((_, index) => index !== 1 && index !== 5 && index !== 8)) unexpected = incomplete.add(packet) || unexpected
if (unexpected || incomplete.progress()?.missing.join(',') !== '1,5,8') throw new Error('Three erasures incorrectly reconstructed')
const denseNack = decodeHandshakeNack(encodeHandshakeNack(offer.sessionId, HANDSHAKE_NACK_DENSE, 12, 7, (1 << 1) | (1 << 5) | (1 << 8)))
if (!denseNack) throw new Error('Dense optical NACK did not decode')
const nackBytes = encodeHandshakeNack(offer.sessionId, HANDSHAKE_NACK_DENSE, 12, 7, 1 << 1)
const opticalNack = decodeOpticalCells(encodeOpticalFrame(nackBytes, 5, 0, DEBUG_PROFILE).cells, DEBUG_PROFILE)
if (!opticalNack.ok || !decodeHandshakeNack(opticalNack.payload)) throw new Error('Optical NACK frame did not round trip')
if (decodeHandshakeOffer(nackBytes) || decodeKeyConfirm(nackBytes) || decodeReadyConfirm(nackBytes)) throw new Error('Unauthenticated NACK masqueraded as offer, key confirmation, or READY')
if (!isFreshHandshakeNackRequest(7, undefined, 1000, undefined) || isFreshHandshakeNackRequest(7, 7, 2000, 1000) || isFreshHandshakeNackRequest(6, 7, 2000, 1000) || isFreshHandshakeNackRequest(8, 7, 1500, 1000) || !isFreshHandshakeNackRequest(8, 7, 1800, 1000) || !isFreshHandshakeNackRequest(0, 65535, 3000, 1000)) throw new Error('Duplicate, stale, or too-frequent NACK was not gated')
const selectedDense = selectHandshakeNackRetransmissions(denseNack, offer.sessionId, dense, 400)
if (selectedDense.length !== 3 || selectedDense.some((packet, index) => packet.sequence !== 400 + index || parseDenseHandshakeFragment(packet)?.index !== [1, 5, 8][index])) throw new Error('Dense selective retransmission chose incorrect fragments')
let repaired = null
for (const packet of selectedDense) repaired = incomplete.add(packet) || repaired
if (!repaired || repaired.message.some((value, index) => value !== message[index])) throw new Error('Selective dense retransmission failed')
const tampered = dense.map(packet => ({ ...packet, payload: packet.payload.slice() }))
tampered[0].payload[3] ^= 1
const tamperedAssembly = new DenseHandshakeReassembler(offer.sessionId, codec)
let tamperedMessage: Uint8Array | null = null
for (const packet of tampered) tamperedMessage = tamperedAssembly.add(unpackControlPacket(packControlPacket(packet))!)?.message || tamperedMessage
const tamperedResponse = tamperedMessage && decodeHandshakeResponse(tamperedMessage)
let tamperAccepted = false
try { if (tamperedResponse) { deriveHandshakeMaterial(offer, tamperedResponse, sender.privateKey); tamperAccepted = true } } catch { /* transcript binding rejects a CRC-valid malicious shard */ }
if (tamperAccepted) throw new Error('CRC-valid malicious response shard bypassed transcript binding')
const downgradedResponse = { ...response, capabilities: response.capabilities & ~HANDSHAKE_CAPABILITY_RESPONSE_PARITY }
let downgradeAccepted = false
try { deriveHandshakeMaterial(offer, downgradedResponse, sender.privateKey); downgradeAccepted = true } catch { /* negotiated capabilities are transcript-bound */ }
if (downgradeAccepted) throw new Error('Response parity capability downgrade bypassed transcript binding')

const legacy = fragmentHandshakeMessage(transferId, 500, transferId, 1, message)
if (legacy.length !== 18) throw new Error('Legacy response count changed')
const legacyAssembler = new AcousticFragmentReassembler()
for (const packet of legacy.slice(0, 17).reverse()) if (legacyAssembler.add(packet)) throw new Error('17/18 response completed without missing fragment')
const missingLegacy = legacyAssembler.missing(transferId, transferId & 0xffff, 1)
if (missingLegacy?.missing.join(',') !== '17') throw new Error('17/18 case did not identify the missing fragment')
const legacyNack = decodeHandshakeNack(encodeHandshakeNack(offer.sessionId, HANDSHAKE_NACK_LEGACY, 18, 8, 1 << 17))
const selectedLegacy = selectHandshakeNackRetransmissions(legacyNack!, offer.sessionId, legacy, 700)
if (selectedLegacy.length !== 1 || selectedLegacy[0].sequence !== 700 || selectedLegacy[0].payload[3] !== 17) throw new Error('17/18 NACK replayed more than the missing fragment')
const legacyResult = legacyAssembler.add(selectedLegacy[0])
if (!legacyResult || legacyResult.message.some((value, index) => value !== message[index])) throw new Error('17/18 selective repair failed')

const alteredSession = offer.sessionId.slice(); alteredSession[15] ^= 1
if (selectHandshakeNackRetransmissions({ ...denseNack, sessionId: alteredSession }, offer.sessionId, dense, 800).length ||
    selectHandshakeNackRetransmissions({ ...denseNack, format: HANDSHAKE_NACK_LEGACY }, offer.sessionId, dense, 800).length ||
    selectHandshakeNackRetransmissions({ ...denseNack, count: 13 }, offer.sessionId, dense, 800).length ||
    decodeHandshakeNack(encodeHandshakeNack(offer.sessionId, HANDSHAKE_NACK_DENSE, 12, 9, 1).map((byte, index) => index === 21 ? 0 : byte)) !== null) throw new Error('Spurious NACK was accepted')
const corruptPacket = packControlPacket(dense[0]); corruptPacket[15] ^= 1
if (unpackControlPacket(corruptPacket)) throw new Error('Corrupt dense acoustic CRC was accepted')
for (const malformed of [Uint8Array.of(), Uint8Array.of(1, 0, 0, ...new Uint8Array(9)), Uint8Array.of(1, 31, 108, ...new Uint8Array(9)), Uint8Array.of(1, 0, 108, ...new Uint8Array(8))]) {
  if (parseDenseHandshakeFragment({ ...dense[0], payload: malformed })) throw new Error('Malformed dense fragment was accepted')
}
const expiring = new DenseHandshakeReassembler(offer.sessionId, codec, 100)
for (const packet of dense.slice(0, 11)) expiring.add(packet, 1000)
if (expiring.add(dense[11], 1200)) throw new Error('Expired response fragments combined with a later packet')
const otherSession = offer.sessionId.slice(); otherSession[4] ^= 1
const mixed = new DenseHandshakeReassembler(offer.sessionId, codec)
const foreign = fragmentDenseHandshakeResponse(transferId, 900, otherSession, message, codec())
if (mixed.add(foreign[0]) || mixed.progress()) throw new Error('Different-session dense fragment entered assembly')
const olderOffer = makeOffer(sender, 0)
const olderMessage = encodeHandshakeResponse(makeResponse(olderOffer, receiver, 2, 0))
if (fragmentHandshakeMessage(new DataView(olderOffer.sessionId.buffer).getUint32(0), 0, new DataView(olderOffer.sessionId.buffer).getUint32(0), 1, olderMessage).length !== 18) throw new Error('Legacy fallback changed')
const denseSeconds = dense.reduce((seconds, packet) => seconds + encodeOctalFskHandshakePacket(packet).length / 48000 + 0.015, 0)
const legacySeconds = legacy.reduce((seconds, packet) => seconds + encodeOctalFskHandshakePacket(packet).length / 48000 + 0.015, 0)
if (denseSeconds >= 18 || legacySeconds <= 22) throw new Error('Handshake airtime target was not met')
console.log(JSON.stringify({ result: 'ok', legacyPackets: legacy.length, densePackets: dense.length, denseSeconds: Number(denseSeconds.toFixed(2)), legacySeconds: Number(legacySeconds.toFixed(2)) }))
