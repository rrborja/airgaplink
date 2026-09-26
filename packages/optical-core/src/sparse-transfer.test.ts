import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { ReedSolomonErasure } from '@digitaldefiance/reed-solomon-erasure.wasm/browser'
import { ReceivedBlockMap } from './received-block-map.ts'
import { CyclicOpticalBlockEncryptor, aesGcmDecrypt, cyclicOpticalBlockAad, cyclicOpticalNonce } from './crypto.ts'
import { OpticalBlockCollector, ReedSolomonBlockCodec, packOpticalSymbol, unpackOpticalSymbol } from './fec.ts'
import { makeMissingHintPayload, packControlPacket, readMissingHintPayload, unpackControlPacket, ControlType } from './control.ts'
import { encodeOctalFskPacket, decodeOctalFskSamples } from './octal-fsk.ts'
import { transferCompletionTag } from './handshake.ts'
import { DENSE_BINARY_PROFILE, binaryRepeatedPayloadCapacity, decodeOpticalCells, encodeOpticalFrame } from './index.ts'

const map = new ReceivedBlockMap(); map.configure(66)
for (const id of [65, 1, 33, 0, 1]) map.add(id)
assert.equal(map.size, 4)
assert.equal(map.firstMissing(), 2)
assert.equal(map.missingCount, 62)
assert.deepEqual(map.nextMissingWindow(1)?.windowBase, 32)
assert.deepEqual(map.nextMissingWindow(2)?.windowBase, 64)
assert.equal(map.has(1), true)
assert.equal(map.has(2), false)

const hint = makeMissingHintPayload(32, 0xfffffffd, 4)
const packet = packControlPacket({ type: ControlType.MISSING_HINT, transferId: 3, sequence: 9, payload: hint })
assert.deepEqual(readMissingHintPayload(unpackControlPacket(packet)!.payload), { windowBase: 32, missingMask: 0xfffffffd, completedCount: 4 })
const acoustic = encodeOctalFskPacket({ type: ControlType.MISSING_HINT, transferId: 3, sequence: 9, payload: hint }, 48_000)
assert.ok(decodeOctalFskSamples(acoustic, 48_000).some(item => item.type === ControlType.MISSING_HINT && item.sequence === 9))
const corrupt = packet.slice(); corrupt[14] ^= 1
assert.equal(unpackControlPacket(corrupt), null)

const wasm = readFileSync(new URL(import.meta.resolve('@digitaldefiance/reed-solomon-erasure.wasm/wasm')))
const codec = new ReedSolomonBlockCodec(ReedSolomonErasure.fromBytes(wasm))
const key = Uint8Array.from({ length: 32 }, (_, i) => i), prefix = Uint8Array.of(1, 2, 3, 4), session = Uint8Array.from({ length: 16 }, (_, i) => 20 + i)
const encryptor = new CyclicOpticalBlockEncryptor(key, prefix, session, 99)
const plain = Uint8Array.from({ length: 80 }, (_, i) => i * 3 & 255)
const first = await encryptor.encryptNext(5, plain), second = await encryptor.encryptNext(5, plain)
assert.equal(first.visit, 0); assert.equal(second.visit, 1)
assert.notDeepEqual(first.bytes, second.bytes)
assert.notDeepEqual(cyclicOpticalNonce(prefix, 5, 0), cyclicOpticalNonce(prefix, 5, 1))
assert.deepEqual(await aesGcmDecrypt(key, cyclicOpticalNonce(prefix, 5, 1), second.bytes, cyclicOpticalBlockAad(session, 99, 5, 1)), plain)
await assert.rejects(aesGcmDecrypt(key, cyclicOpticalNonce(prefix, 5, 0), second.bytes, cyclicOpticalBlockAad(session, 99, 5, 0)))
const encoded = codec.encode(first.bytes, 16)
const collector = new OpticalBlockCollector(new ReedSolomonBlockCodec(ReedSolomonErasure.fromBytes(wasm)), 99, 5, first.visit)
let recovered: Uint8Array | null = null
for (const index of [9, 7, 6, 4, 3, 2, 1, 0, 0]) {
  const symbol = unpackOpticalSymbol(packOpticalSymbol({ transferId: 99, blockId: 5, visit: first.visit, index, sourceCount: 8, repairCount: 2, sourceBytes: encoded.sourceBytes, bytes: encoded.symbols[index] }))!
  assert.equal(symbol.visit, 0)
  recovered = collector.add(symbol) || recovered
}
assert.deepEqual(recovered, first.bytes, 'two missing shards recover through FEC')
assert.deepEqual(await aesGcmDecrypt(key, cyclicOpticalNonce(prefix, 5, 0), recovered!, cyclicOpticalBlockAad(session, 99, 5, 0)), plain)
const wrongVisit = unpackOpticalSymbol(packOpticalSymbol({ transferId: 99, blockId: 5, visit: 1, index: 8, sourceCount: 8, repairCount: 2, sourceBytes: encoded.sourceBytes, bytes: encoded.symbols[8] }))!
assert.equal(collector.add(wrongVisit), null)

// The denser profile must fit a full encrypted version-2 symbol, including
// its four-byte visit field, while retaining three spatial copies and FEC.
const denseShardBytes = binaryRepeatedPayloadCapacity(DENSE_BINARY_PROFILE) - 20
const densePlain = Uint8Array.from({ length: denseShardBytes * 8 - 17 }, (_, i) => (i * 41 + 13) & 255)
const denseCipher = await encryptor.encryptNext(6, densePlain)
const denseBlock = codec.encode(denseCipher.bytes, denseShardBytes)
const denseCollector = new OpticalBlockCollector(new ReedSolomonBlockCodec(ReedSolomonErasure.fromBytes(wasm)), 99, 6, denseCipher.visit)
let denseRecovered: Uint8Array | null = null
for (const index of [9, 8, 7, 6, 4, 3, 1, 0]) {
  const packet = packOpticalSymbol({ transferId: 99, blockId: 6, visit: denseCipher.visit, index, sourceCount: 8, repairCount: 2, sourceBytes: denseBlock.sourceBytes, bytes: denseBlock.symbols[index] })
  assert.equal(packet.length, binaryRepeatedPayloadCapacity(DENSE_BINARY_PROFILE))
  const frame = encodeOpticalFrame(packet, index + 100, 6, DENSE_BINARY_PROFILE)
  const decoded = decodeOpticalCells(frame.cells, DENSE_BINARY_PROFILE)
  if (!decoded.ok) throw new Error(`Dense secure optical frame failed: ${decoded.reason}`)
  denseRecovered = denseCollector.add(unpackOpticalSymbol(decoded.payload)!) || denseRecovered
}
assert.deepEqual(await aesGcmDecrypt(key, cyclicOpticalNonce(prefix, 6, denseCipher.visit), denseRecovered!, cyclicOpticalBlockAad(session, 99, 6, denseCipher.visit)), densePlain)

const digest = createHash('sha256').update(plain).digest(), transcript = Uint8Array.from({ length: 32 }, (_, i) => 90 + i)
const complete = transferCompletionTag(key, transcript, digest, 1)
assert.equal(complete.length, 12)
assert.notDeepEqual(complete, transferCompletionTag(key, transcript, digest, 2))
assert.notDeepEqual(complete, transferCompletionTag(key, transcript, createHash('sha256').update('bad').digest(), 1))
encryptor.clear()
await assert.rejects(encryptor.encryptNext(5, plain))
console.log(JSON.stringify({ result: 'ok', sparseBlocks: map.size, fecRecovered: true }))
