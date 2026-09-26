import 'fake-indexeddb/auto'
import { sha256 } from '@noble/hashes/sha2.js'
import { TRANSFER_MANIFEST_BYTES, packTransferManifest } from '../../optical-core/src/index.ts'
import { IndexedDbOpticalSink } from './indexeddb-sink.ts'

if (!await IndexedDbOpticalSink.probe()) throw new Error('IndexedDB block probe failed')

const archive = new Uint8Array(17 * 1024 * 1024 + 123)
for (let index = 0; index < archive.length; index += 1) archive[index] = (index * 37 + (index >>> 8)) & 255
const blockBytes = 1024 * 1024, totalBlocks = Math.ceil((TRANSFER_MANIFEST_BYTES + archive.length) / blockBytes)
const manifest = { transferId: 456, archiveBytes: archive.length, blockBytes, totalBlocks, sha256: sha256(archive) }
const source = new Uint8Array(TRANSFER_MANIFEST_BYTES + archive.length)
source.set(packTransferManifest(manifest)); source.set(archive, TRANSFER_MANIFEST_BYTES)
const sink = await IndexedDbOpticalSink.create(manifest)
for (let blockId = totalBlocks - 1; blockId >= 0; blockId -= 1) {
  await sink.writeBlock(blockId, source.subarray(blockId * blockBytes, Math.min((blockId + 1) * blockBytes, source.length)))
}
const reconstructed = new Uint8Array(await (await sink.finish()).arrayBuffer())
if (reconstructed.length !== archive.length || reconstructed.some((value, index) => value !== archive[index])) throw new Error('Large IndexedDB sink reconstruction failed')
await sink.remove()
const smallBlockArchive = archive.subarray(0, 512 * 1024 + 37)
const smallBlockBytes = 5500, smallBlockCount = Math.ceil((TRANSFER_MANIFEST_BYTES + smallBlockArchive.length) / smallBlockBytes)
const smallManifest = { transferId: 457, archiveBytes: smallBlockArchive.length, blockBytes: smallBlockBytes, totalBlocks: smallBlockCount, sha256: sha256(smallBlockArchive) }
const smallSource = new Uint8Array(TRANSFER_MANIFEST_BYTES + smallBlockArchive.length)
smallSource.set(packTransferManifest(smallManifest)); smallSource.set(smallBlockArchive, TRANSFER_MANIFEST_BYTES)
const smallSink = await IndexedDbOpticalSink.create(smallManifest)
for (let blockId = smallBlockCount - 1; blockId >= 0; blockId -= 1) await smallSink.writeBlock(blockId, smallSource.subarray(blockId * smallBlockBytes, Math.min((blockId + 1) * smallBlockBytes, smallSource.length)))
const smallResult = new Uint8Array(await (await smallSink.finish()).arrayBuffer())
if (smallResult.length !== smallBlockArchive.length || smallResult.some((value, index) => value !== smallBlockArchive[index])) throw new Error('Batched small-block verification failed')
await smallSink.remove()
async function expectFailure(operation: Promise<unknown>, expected: RegExp) {
  try { await operation } catch (error) { if (error instanceof Error && expected.test(error.message)) return; throw error }
  throw new Error(`Expected ${expected} failure`)
}
// A sparse sink cannot declare completion when a middle block was never
// reconstructed, even if later blocks and the manifest arrived first.
const incomplete = await IndexedDbOpticalSink.create(smallManifest)
for (let blockId = smallBlockCount - 1; blockId >= 0; blockId -= 1) if (blockId !== 2) await incomplete.writeBlock(blockId, smallSource.subarray(blockId * smallBlockBytes, Math.min((blockId + 1) * smallBlockBytes, smallSource.length)))
await expectFailure(incomplete.finish(), /Missing stored optical block 2/)
await incomplete.remove()
// All positions present is still insufficient: the manifest's SHA-256 must
// match the reconstructed archive before completion can be sent.
const corrupt = await IndexedDbOpticalSink.create(smallManifest)
for (let blockId = smallBlockCount - 1; blockId >= 0; blockId -= 1) {
  const bytes = smallSource.subarray(blockId * smallBlockBytes, Math.min((blockId + 1) * smallBlockBytes, smallSource.length)).slice()
  if (blockId === 2) bytes[0] ^= 1
  await corrupt.writeBlock(blockId, bytes)
}
await expectFailure(corrupt.finish(), /SHA-256 mismatch/)
await corrupt.remove()
console.log(JSON.stringify({ result: 'ok', archiveBytes: reconstructed.length, sha256Verified: true }))
