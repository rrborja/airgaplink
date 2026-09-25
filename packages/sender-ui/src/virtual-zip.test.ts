import { sha256 } from '@noble/hashes/sha2.js'
import { BlobReader, BlobWriter, ZipReader } from '@zip.js/zip.js'
import { createVirtualZipArchive } from './virtual-zip.ts'
import { readTransferBlock } from './local-archive.ts'

const content = new Uint8Array(20 * 1024 * 1024 + 37)
for (let index = 0; index < content.length; index += 1) content[index] = index * 31 & 255
const file = new File([content], 'large.bin')
const nested = new File(['nested'], 'small.txt')
Object.defineProperty(nested, 'webkitRelativePath', { value: 'folder/sub/small.txt' })
const { archive, sha256: expectedHash } = await createVirtualZipArchive([file, nested])
if (archive.size <= content.length) throw new Error('Virtual ZIP has no directory metadata')
const whole = archive.slice(0, archive.size)
const hasher = sha256.create(), reader = whole.stream().getReader()
while (true) { const item = await reader.read(); if (item.done) break; hasher.update(item.value) }
if (hasher.digest().some((byte, index) => byte !== expectedHash[index])) throw new Error('Virtual ZIP SHA-256 mismatch')
const zip = new ZipReader(new BlobReader(whole))
const entries = await zip.getEntries()
const entry = entries[0]
if (entries.length !== 2 || !entry || entry.directory || entry.filename !== 'large.bin' || entries[1].filename !== 'folder/sub/small.txt') throw new Error('Virtual ZIP directory is invalid')
const restored = await entry.getData(new BlobWriter())
if (restored.size !== file.size || new Uint8Array(await restored.slice(-37).arrayBuffer()).some((byte, index) => byte !== content[content.length - 37 + index])) throw new Error('Virtual ZIP contents are invalid')
const second = entries[1]
if (second.directory || await second.getData(new BlobWriter()).then(blob => blob.text()) !== 'nested') throw new Error('Nested ZIP entry is invalid')
await zip.close()
const manifest = Uint8Array.of(1, 2, 3)
const first = await readTransferBlock(archive, manifest, 0, 512)
if (String(first.subarray(0, 3)) !== '1,2,3') throw new Error('Manifest was not prepended to virtual ZIP')
const middle = await readTransferBlock(archive, manifest, 40960, 512)
const expectedMiddle = new Uint8Array(await whole.slice(40960 * 512 - manifest.length, 40961 * 512 - manifest.length).arrayBuffer())
if (middle.some((byte, index) => byte !== expectedMiddle[index])) throw new Error('Random-access virtual ZIP block mismatch')
console.log(JSON.stringify({ result: 'ok', archiveBytes: archive.size, sourceBytes: content.length, digestVerified: true }))
