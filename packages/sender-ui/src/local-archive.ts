import { ZipWriter } from '@zip.js/zip.js'
import { sha256 } from '@noble/hashes/sha2.js'
import type { ArchiveSource } from './virtual-zip'

/** ZIP contents are written to browser-private disk, never to a network sink. */
export interface LocalOpticalArchive { file: File; sha256: Uint8Array; remove(): Promise<void> }

export async function createLocalOpticalArchive(files: File[]): Promise<LocalOpticalArchive> {
  const root = await navigator.storage.getDirectory()
  const name = `optical-send-${crypto.randomUUID()}.zip`
  const handle = await root.getFileHandle(name, { create: true })
  const writable = await handle.createWritable()
  try {
    // Keep compression in this loaded page; zip.js otherwise may fetch a worker
    // script after the user has disconnected networking.
    const zip = new ZipWriter(writable, { level: 6, useWebWorkers: false })
    for (const file of files) {
      const path = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
      await zip.add(path, file.stream())
    }
    await zip.close()
    const archive = await handle.getFile()
    const hasher = sha256.create(), reader = archive.stream().getReader()
    while (true) { const result = await reader.read(); if (result.done) break; hasher.update(result.value) }
    return { file: archive, sha256: hasher.digest(), remove: () => root.removeEntry(name) }
  } catch (error) {
    try { await writable.abort() } catch { /* already closed */ }
    await root.removeEntry(name).catch(() => {})
    throw error
  }
}

export async function readTransferBlock(archive: ArchiveSource, manifest: Uint8Array, blockIndex: number, blockBytes: number) {
  const start = blockIndex * blockBytes, end = Math.min(start + blockBytes, manifest.length + archive.size)
  if (start >= end) throw new Error('Transfer block is outside archive')
  const block = new Uint8Array(end - start)
  if (start < manifest.length) block.set(manifest.subarray(start, Math.min(end, manifest.length)))
  const archiveStart = Math.max(0, start - manifest.length), archiveEnd = Math.max(0, end - manifest.length)
  if (archiveEnd > archiveStart) block.set(new Uint8Array(await archive.slice(archiveStart, archiveEnd).arrayBuffer()), Math.max(0, manifest.length - start))
  return block
}
