import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ReedSolomonErasure } from '@digitaldefiance/reed-solomon-erasure.wasm/browser'
import { prepareZXingModule as prepareQrReader, readBarcodes } from 'zxing-wasm/reader'
import { prepareZXingModule as prepareQrWriter, writeBarcode } from 'zxing-wasm/writer'
import { CyclicOpticalBlockEncryptor, ReedSolomonBlockCodec, aesGcmDecrypt, calibrationFrameId, crc32, cyclicOpticalBlockAad, cyclicOpticalNonce, packOpticalSymbol, type OpticalImageDecode } from '../../optical-core/src/index.ts'
import { PhoneBlockAssembler, PhoneDisplayFrameSelector } from './phone-block-assembler.ts'
import { hasPhonePairingHash, parsePhonePairingHash } from './phone-pairing.ts'
import { PHONE_CAMERA_FRAME_MAX, decodePhoneRelayMessage, encodePhoneRelayMessage, type PhoneRelayMessage } from './phone-relay-protocol.ts'

const pairingHash = `#phone=${'A'.repeat(12)}.${'b'.repeat(32)}`
assert.equal(hasPhonePairingHash(pairingHash), true)
assert.deepEqual(parsePhonePairingHash(pairingHash), { id: 'A'.repeat(12), token: 'b'.repeat(32) })
assert.equal(hasPhonePairingHash(`#phone=${'A'.repeat(12)}`), true)
assert.equal(parsePhonePairingHash(`#phone=${'A'.repeat(12)}`), null)
assert.equal(parsePhonePairingHash(`#phone=${'A'.repeat(12)}.${'b'.repeat(31)}`), null)
await prepareQrWriter({ overrides: { wasmBinary: readFileSync(new URL(import.meta.resolve('zxing-wasm/writer/zxing_writer.wasm'))) }, fireImmediately: true })
await prepareQrReader({ overrides: { wasmBinary: readFileSync(new URL(import.meta.resolve('zxing-wasm/reader/zxing_reader.wasm'))) }, fireImmediately: true })
const pairingUrl = `https://receiver.example/#phone=${'A'.repeat(12)}.${'b'.repeat(32)}`
const qr = await writeBarcode(pairingUrl, { format: 'QRCode', options: 'ecLevel=M', scale: 10, addQuietZones: true })
assert.equal(qr.error, '')
const qrPixels = new Uint8ClampedArray(qr.symbol.data.length * 4)
for (let index = 0; index < qr.symbol.data.length; index += 1) { qrPixels[index * 4] = qr.symbol.data[index]; qrPixels[index * 4 + 1] = qr.symbol.data[index]; qrPixels[index * 4 + 2] = qr.symbol.data[index]; qrPixels[index * 4 + 3] = 255 }
const qrDecoded = await readBarcodes({ data: qrPixels, width: qr.symbol.width, height: qr.symbol.height, colorSpace: 'srgb' }, { formats: ['QRCode'] })
assert.equal(qrDecoded[0]?.text, pairingUrl)

for (const message of [
  { kind: 'control', profileId: 8, frameId: 4, blockId: 99, payload: Uint8Array.of(1, 2, 3) },
  { kind: 'observation', profileId: 8, frameId: calibrationFrameId(2, 7), transferId: 99, blockId: 0, shardIndex: 7 },
  { kind: 'block', profileId: 8, transferId: 99, blockId: 4, visit: 2, bytes: new Uint8Array(100) },
  { kind: 'telemetry', cameraFps: 119.8, processedFps: 75, validFps: 60, uniqueFps: 59.9, failures: 9, recoveredBlocks: 5, repeatedFrames: 41, usefulShards: 43, usefulShardBytes: 81_000 },
  { kind: 'telemetry', cameraFps: 18.5, processedFps: 16.5, validFps: 0, uniqueFps: 0, failures: 3860, recoveredBlocks: 0, repeatedFrames: 0, usefulShards: 0, usefulShardBytes: 0, decodeReason: 2, finderStage: 4, pixelsPerCell: 2.5, capturePath: 2 },
  { kind: 'config', profileId: 8, transferId: 99 },
  { kind: 'camera-path', lossless: true },
  { kind: 'camera-path', lossless: false },
  { kind: 'ack', transferId: 99, blockId: 4 },
] as PhoneRelayMessage[]) {
  const encoded = encodePhoneRelayMessage(message)
  assert.deepEqual(decodePhoneRelayMessage(encoded), message)
  assert.equal(decodePhoneRelayMessage(encoded.subarray(0, encoded.length - 1)), null)
}
const malformed = encodePhoneRelayMessage({ kind: 'block', profileId: 8, transferId: 99, blockId: 4, visit: 2, bytes: new Uint8Array(100) })
malformed[20] ^= 1
assert.equal(decodePhoneRelayMessage(malformed), null)
const png = new Uint8Array(120_000)
png.set([137, 80, 78, 71, 13, 10, 26, 10])
for (let index = 8; index < png.length; index++) png[index] = index & 255
const imagePacket = encodePhoneRelayMessage({ kind: 'camera-frame', profileId: 8, sequence: 42, png })
assert.deepEqual(decodePhoneRelayMessage(imagePacket), { kind: 'camera-frame', profileId: 8, sequence: 42, png })
assert.equal(decodePhoneRelayMessage(imagePacket.subarray(0, imagePacket.length - 1)), null)
const changedLength = imagePacket.slice(); changedLength[12] ^= 1
assert.equal(decodePhoneRelayMessage(changedLength), null)
assert.throws(() => encodePhoneRelayMessage({ kind: 'camera-frame', profileId: 8, sequence: 1, png: new Uint8Array(PHONE_CAMERA_FRAME_MAX + 1) }))
const imageAck = { kind: 'camera-ack', sequence: 42, valid: true, decodeReason: 1, frameId: 3910 } as const
assert.deepEqual(decodePhoneRelayMessage(encodePhoneRelayMessage(imageAck)), imageAck)
const badCameraPath = encodePhoneRelayMessage({ kind: 'camera-path', lossless: true }); badCameraPath[4] = 2
assert.equal(decodePhoneRelayMessage(badCameraPath), null)

const wasm = readFileSync(new URL(import.meta.resolve('@digitaldefiance/reed-solomon-erasure.wasm/wasm')))
const codec = new ReedSolomonBlockCodec(ReedSolomonErasure.fromBytes(wasm))
const assembler = new PhoneBlockAssembler(codec)
const plaintext = Uint8Array.from({ length: 140 }, (_, index) => index)
const encoded = codec.encode(plaintext, 20)
function frame(frameId: number, index: number, visit = 3): OpticalImageDecode {
  const payload = packOpticalSymbol({ transferId: 99, blockId: 2, index, visit, sourceCount: 8, repairCount: 2, sourceBytes: encoded.sourceBytes, bytes: encoded.symbols[index] })
  return { ok: true, header: { version: 1, profileId: 8, frameId, blockId: 2, payloadLength: payload.length, payloadCrc32: crc32(payload) }, payload, metadataAgreement: 1, symbolConfidence: 0.8 }
}
const selector = new PhoneDisplayFrameSelector()
assert.equal(selector.accept(frame(10, 0), 0), null)
assert.equal(selector.accept({ ...frame(10, 0), symbolConfidence: 0.95 }, 8), null)
assert.equal(selector.repeatedCaptures, 1)
assert.equal(selector.accept(frame(11, 1), 17)?.symbolConfidence, 0.95)
assert.equal(selector.flush(30), null)
assert.equal(selector.flush(60)?.header.frameId, 11)
let recovered: PhoneRelayMessage | undefined
for (const index of [7, 0, 6, 1, 4, 2, 3, 5]) recovered = assembler.accept(frame(20 + index, index), index).find(item => item.kind === 'block') || recovered
assert.equal(recovered?.kind, 'block')
if (recovered?.kind === 'block') assert.deepEqual(recovered.bytes, plaintext)
assert.equal(assembler.accept(frame(40, 5), 50).filter(item => item.kind === 'block').length, 0)
for (const index of [0, 1, 2, 3, 4, 5, 6, 7]) assert.equal(assembler.accept(frame(60 + index, index, 4), 100 + index).filter(item => item.kind === 'block').length, 0)
let retried = false
for (const index of [0, 1, 2, 3, 4, 5, 6, 7]) retried ||= assembler.accept(frame(80 + index, index, 5), 3100 + index).some(item => item.kind === 'block')
assert.equal(retried, true)
assembler.acknowledge(2)
assert.equal(assembler.accept(frame(50, 0, 4), 60).filter(item => item.kind === 'block').length, 0)
const calibration = assembler.accept(frame(calibrationFrameId(2, 7), 7, 4), 70)
assert.equal(calibration[0]?.kind, 'observation')
const controlPayload = Uint8Array.of(1, 2, 3)
const control: OpticalImageDecode = { ok: true, header: { version: 1, profileId: 8, frameId: 99, blockId: 0, payloadLength: 3, payloadCrc32: crc32(controlPayload) }, payload: controlPayload, metadataAgreement: 1 }
assert.equal(assembler.accept(control, 100).length, 1)
assert.equal(assembler.accept(control, 101).length, 0)
assert.equal(assembler.accept(control, 2500).length, 1)
const key = Uint8Array.from({ length: 32 }, (_, index) => index + 1), prefix = Uint8Array.of(1, 2, 3, 4), sessionId = Uint8Array.from({ length: 16 }, (_, index) => index + 5)
const encryptor = new CyclicOpticalBlockEncryptor(key, prefix, sessionId, 99)
const encrypted = await encryptor.encryptNext(3, plaintext), shards = codec.encode(encrypted.bytes, 24), securePhone = new PhoneBlockAssembler(codec)
let secureMessage: PhoneRelayMessage | undefined
for (const index of [0, 1, 2, 3, 4, 5, 6, 8]) {
  const payload = packOpticalSymbol({ transferId: 99, blockId: 3, index, visit: encrypted.visit, sourceCount: 8, repairCount: 2, sourceBytes: shards.sourceBytes, bytes: shards.symbols[index] })
  const result: OpticalImageDecode = { ok: true, header: { version: 1, profileId: 8, frameId: 100 + index, blockId: 3, payloadLength: payload.length, payloadCrc32: crc32(payload) }, payload, metadataAgreement: 1 }
  secureMessage = securePhone.accept(result, index).find(item => item.kind === 'block') || secureMessage
}
assert.equal(secureMessage?.kind, 'block')
if (secureMessage?.kind === 'block') {
  const delivered = decodePhoneRelayMessage(encodePhoneRelayMessage(secureMessage))
  assert.equal(delivered?.kind, 'block')
  if (delivered?.kind === 'block') {
    const nonce = cyclicOpticalNonce(prefix, delivered.blockId, delivered.visit), aad = cyclicOpticalBlockAad(sessionId, delivered.transferId, delivered.blockId, delivered.visit)
    assert.deepEqual(await aesGcmDecrypt(key, nonce, delivered.bytes, aad), plaintext)
    const tampered = delivered.bytes.slice(); tampered[0] ^= 1
    await assert.rejects(aesGcmDecrypt(key, nonce, tampered, aad))
  }
}
encryptor.clear()
console.log(JSON.stringify({ result: 'ok', recoveredBlocks: assembler.recoveredBlocks, repeatedCaptures: selector.repeatedCaptures }))
