import { sha256 } from '@noble/hashes/sha2.js'

/** Random-access ZIP backed by the selected files, with no archive-sized buffer. */
export interface ArchiveSource { size: number; slice(start: number, end: number): Blob }
interface Segment { start: number; end: number; bytes?: Uint8Array; file?: File }
interface Entry { file: File; name: Uint8Array; offset: number; header: Uint8Array; crc: number }
const MAX_ZIP32 = 0xffffffff
const HASH_CHUNK_BYTES = 256 * 1024
const encoder = new TextEncoder()
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1
  return value >>> 0
})

function updateCrc(crc: number, bytes: Uint8Array) {
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255]
  return crc >>> 0
}
function entryName(file: File) {
  const path = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
  if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid ZIP entry path')
  const name = encoder.encode(path)
  if (name.length > 65535) throw new Error('ZIP entry path is too long')
  return name
}
function localHeader(name: Uint8Array) {
  const bytes = new Uint8Array(30 + name.length), view = new DataView(bytes.buffer)
  view.setUint32(0, 0x04034b50, true); view.setUint16(4, 20, true)
  view.setUint16(6, 0x0808, true); view.setUint16(12, 0x21, true)
  view.setUint16(26, name.length, true); bytes.set(name, 30)
  return bytes
}
function descriptor(crc: number, size: number) {
  const bytes = new Uint8Array(16), view = new DataView(bytes.buffer)
  view.setUint32(0, 0x08074b50, true); view.setUint32(4, crc, true)
  view.setUint32(8, size, true); view.setUint32(12, size, true)
  return bytes
}
function centralHeader(entry: Entry) {
  const bytes = new Uint8Array(46 + entry.name.length), view = new DataView(bytes.buffer)
  view.setUint32(0, 0x02014b50, true); view.setUint16(4, 20, true); view.setUint16(6, 20, true)
  view.setUint16(8, 0x0808, true); view.setUint16(14, 0x21, true)
  view.setUint32(16, entry.crc, true); view.setUint32(20, entry.file.size, true); view.setUint32(24, entry.file.size, true)
  view.setUint16(28, entry.name.length, true); view.setUint32(42, entry.offset, true)
  bytes.set(entry.name, 46)
  return bytes
}
function endRecord(entries: number, centralSize: number, centralOffset: number) {
  const bytes = new Uint8Array(22), view = new DataView(bytes.buffer)
  view.setUint32(0, 0x06054b50, true)
  view.setUint16(8, entries, true); view.setUint16(10, entries, true)
  view.setUint32(12, centralSize, true); view.setUint32(16, centralOffset, true)
  return bytes
}

class VirtualZipArchive implements ArchiveSource {
  readonly size: number
  private readonly segments: Segment[]
  constructor(size: number, segments: Segment[]) { this.size = size; this.segments = segments }
  slice(start: number, end: number): Blob {
    const from = Math.max(0, Math.min(this.size, start)), to = Math.max(from, Math.min(this.size, end))
    const parts: BlobPart[] = []
    let low = 0, high = this.segments.length
    while (low < high) { const middle = (low + high) >>> 1; if (this.segments[middle].end <= from) low = middle + 1; else high = middle }
    for (let index = low; index < this.segments.length && this.segments[index].start < to; index += 1) {
      const segment = this.segments[index], left = Math.max(from, segment.start) - segment.start, right = Math.min(to, segment.end) - segment.start
      if (segment.bytes) parts.push(segment.bytes.slice(left, right) as BlobPart)
      else if (segment.file) parts.push(segment.file.slice(left, right))
    }
    return new Blob(parts)
  }
}

/** STORE-mode ZIP fallback for browsers without usable private disk storage. */
export async function createVirtualZipArchive(files: File[], onProgress?: (processed: number, total: number) => void): Promise<{ archive: ArchiveSource; sha256: Uint8Array }> {
  if (files.length > 65535) throw new Error('Too many files for the browser-storage fallback ZIP')
  const entries: Entry[] = [], segments: Segment[] = [], hasher = sha256.create()
  let position = 0, centralSize = 0
  for (const file of files) {
    const name = entryName(file), header = localHeader(name)
    if (file.size > MAX_ZIP32 || position + header.length + file.size + 16 > MAX_ZIP32) throw new Error('Browser storage is unavailable and the directory exceeds the 4 GiB fallback ZIP limit')
    entries.push({ file, name, offset: position, header, crc: 0 })
    position += header.length + file.size + 16
    centralSize += 46 + name.length
  }
  if (position + centralSize + 22 > MAX_ZIP32) throw new Error('Browser storage is unavailable and the directory exceeds the 4 GiB fallback ZIP limit')
  position = 0
  const totalSourceBytes = files.reduce((sum, file) => sum + file.size, 0)
  let processed = 0, lastReport = 0
  onProgress?.(0, totalSourceBytes)
  const addBytes = (bytes: Uint8Array) => { segments.push({ start: position, end: position + bytes.length, bytes }); position += bytes.length; hasher.update(bytes) }
  for (const [entryIndex, entry] of entries.entries()) {
    addBytes(entry.header)
    segments.push({ start: position, end: position + entry.file.size, file: entry.file }); position += entry.file.size
    let crc = 0xffffffff
    for (let offset = 0; offset < entry.file.size; offset += HASH_CHUNK_BYTES) {
      let bytes: Uint8Array
      try { bytes = new Uint8Array(await entry.file.slice(offset, offset + HASH_CHUNK_BYTES).arrayBuffer()) }
      catch (error) { throw new Error(`Could not read selected file ${entryIndex + 1} of ${entries.length} at byte ${offset}: ${error instanceof Error ? error.message : String(error)}`) }
      crc = updateCrc(crc, bytes); hasher.update(bytes)
      processed += bytes.length
      if (processed - lastReport >= 1024 * 1024 || processed === totalSourceBytes) {
        onProgress?.(processed, totalSourceBytes); lastReport = processed
        // Give Safari a paint and collection opportunity during large directory scans.
        await new Promise<void>(resolve => setTimeout(resolve, 0))
      }
    }
    entry.crc = (crc ^ 0xffffffff) >>> 0
    addBytes(descriptor(entry.crc, entry.file.size))
  }
  const centralOffset = position
  for (const entry of entries) addBytes(centralHeader(entry))
  addBytes(endRecord(entries.length, position - centralOffset, centralOffset))
  return { archive: new VirtualZipArchive(position, segments), sha256: hasher.digest() }
}
