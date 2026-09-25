import { sha256 } from '@noble/hashes/sha2.js'
import { TRANSFER_MANIFEST_BYTES, type TransferManifest } from '../../optical-core/src/index.ts'

/** Browser-private disk sink for reconstructed optical blocks. */
export class LocalOpticalSink {
  private pending: Promise<void> = Promise.resolve()
  private closed = false
  private readonly root: FileSystemDirectoryHandle
  private readonly name: string
  private readonly handle: FileSystemFileHandle
  private readonly writable: FileSystemWritableFileStream
  private readonly manifest: TransferManifest
  private constructor(root: FileSystemDirectoryHandle, name: string, handle: FileSystemFileHandle, writable: FileSystemWritableFileStream, manifest: TransferManifest) {
    this.root = root; this.name = name; this.handle = handle; this.writable = writable; this.manifest = manifest
  }

  static async create(manifest: TransferManifest) {
    const root = await navigator.storage.getDirectory()
    const name = `optical-receive-${crypto.randomUUID()}.zip`
    const handle = await root.getFileHandle(name, { create: true })
    const writable = await handle.createWritable()
    return new LocalOpticalSink(root, name, handle, writable, manifest)
  }

  writeBlock(blockId: number, bytes: Uint8Array) {
    if (this.closed || blockId >= this.manifest.totalBlocks || blockId < 0) throw new Error('Invalid optical block write')
    const expected = Math.min(this.manifest.blockBytes, TRANSFER_MANIFEST_BYTES + this.manifest.archiveBytes - blockId * this.manifest.blockBytes)
    if (bytes.length !== expected) throw new Error('Optical block size mismatch')
    this.pending = this.pending.then(async () => {
      await this.writable.seek(blockId * this.manifest.blockBytes)
      await this.writable.write(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
    })
    return this.pending
  }

  async finish() {
    await this.pending
    this.closed = true
    await this.writable.close()
    const file = await this.handle.getFile()
    if (file.size !== TRANSFER_MANIFEST_BYTES + this.manifest.archiveBytes) throw new Error('Optical ZIP length mismatch')
    const archive = file.slice(TRANSFER_MANIFEST_BYTES)
    const hasher = sha256.create(), reader = archive.stream().getReader()
    while (true) { const item = await reader.read(); if (item.done) break; hasher.update(item.value) }
    const digest = hasher.digest()
    if (!digest.every((value, index) => value === this.manifest.sha256[index])) throw new Error('SHA-256 mismatch; transfer not verified')
    return archive
  }

  async remove() { try { if (!this.closed) await this.writable.abort() } catch { /* already closed */ } await this.root.removeEntry(this.name).catch(() => {}) }
}
