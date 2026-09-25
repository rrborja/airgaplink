import { sha256 } from '@noble/hashes/sha2.js'
import { packTransferManifest, TRANSFER_MANIFEST_BYTES } from '../../optical-core/src/index.ts'
import { LocalOpticalSink } from './local-sink.ts'

const archive = new Uint8Array(100).map((_, index) => (index * 37) & 255)
const manifest = { transferId: 123, archiveBytes: archive.length, blockBytes: 64, totalBlocks: 3, sha256: sha256(archive) }
const source = new Uint8Array(TRANSFER_MANIFEST_BYTES + archive.length)
source.set(packTransferManifest(manifest)); source.set(archive, TRANSFER_MANIFEST_BYTES)

let content = new Uint8Array(0), cursor = 0, removed = false
const writable = {
  async seek(position: number) { cursor = position },
  async write(buffer: ArrayBuffer) {
    const bytes = new Uint8Array(buffer)
    if (cursor + bytes.length > content.length) { const expanded = new Uint8Array(cursor + bytes.length); expanded.set(content); content = expanded }
    content.set(bytes, cursor); cursor += bytes.length
  },
  async close() {}, async abort() {},
}
const root = {
  async getFileHandle() { return { async createWritable() { return writable }, async getFile() { return new File([content], 'received.zip') } } },
  async removeEntry() { removed = true },
}
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { storage: { getDirectory: async () => root } } })
const sink = await LocalOpticalSink.create(manifest)
await sink.writeBlock(2, source.subarray(128))
await sink.writeBlock(0, source.subarray(0, 64))
await sink.writeBlock(1, source.subarray(64, 128))
const result = new Uint8Array(await (await sink.finish()).arrayBuffer())
if (result.length !== archive.length || result.some((value, index) => value !== archive[index])) throw new Error('Out-of-order local sink reconstruction failed')
await sink.remove()
if (!removed) throw new Error('Local sink cleanup failed')
console.log(JSON.stringify({ result: 'ok', archiveBytes: result.length, sha256Verified: true }))
