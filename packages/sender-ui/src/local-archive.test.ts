import { sha256 } from '@noble/hashes/sha2.js'
import { BlobReader, TextWriter, ZipReader } from '@zip.js/zip.js'
import { createLocalOpticalArchive, readTransferBlock } from './local-archive.ts'

const chunks: ArrayBuffer[] = []
let removed = false
const root = {
  async getFileHandle(name: string) {
    return {
      async createWritable() { return new WritableStream<Uint8Array>({ write(chunk) { chunks.push(new Uint8Array(chunk).buffer as ArrayBuffer) } }) },
      async getFile() { return new File(chunks, name) },
    }
  },
  async removeEntry() { removed = true },
}
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { storage: { getDirectory: async () => root } } })
const local = await createLocalOpticalArchive([new File(['optical-test'], 'sample.txt')])
const archive = new Uint8Array(await local.file.arrayBuffer())
if (local.sha256.some((value, index) => value !== sha256(archive)[index])) throw new Error('Streaming ZIP digest mismatch')
const reader = new ZipReader(new BlobReader(local.file))
const entries = await reader.getEntries()
const entry = entries[0]
if (!entry || entry.directory || entry.filename !== 'sample.txt' || await entry.getData(new TextWriter()) !== 'optical-test') throw new Error('Streaming ZIP content mismatch')
await reader.close()
const manifest = new Uint8Array([9, 8, 7])
const first = await readTransferBlock(local.file, manifest, 0, 4)
if (String(first) !== `9,8,7,${archive[0]}`) throw new Error('Manifest/archive block boundary mismatch')
await local.remove()
if (!removed) throw new Error('Local archive cleanup failed')
console.log(JSON.stringify({ result: 'ok', zipBytes: archive.length, sha256Verified: true }))
