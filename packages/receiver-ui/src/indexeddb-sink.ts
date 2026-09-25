import { sha256 } from '@noble/hashes/sha2.js'
import { TRANSFER_MANIFEST_BYTES, type TransferManifest } from '../../optical-core/src/index.ts'

const DATABASE = 'qrcopy-optical-receiver'
const STORE = 'blocks'

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'))
  })
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error('IndexedDB is unavailable')); return }
    const request = indexedDB.open(DATABASE, 1)
    request.onupgradeneeded = () => { request.result.createObjectStore(STORE) }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('Could not open IndexedDB'))
    request.onblocked = () => reject(new Error('IndexedDB is blocked by another open page'))
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB write failed'))
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB write aborted'))
  })
}

/** Locally stores one recovered optical block per IndexedDB record. */
export class IndexedDbOpticalSink {
  private pending: Promise<void> = Promise.resolve()
  private readonly database: IDBDatabase
  private readonly prefix: string
  private readonly manifest: TransferManifest
  private closed = false

  private constructor(database: IDBDatabase, prefix: string, manifest: TransferManifest) {
    this.database = database; this.prefix = prefix; this.manifest = manifest
  }

  static async probeWithReason(): Promise<{ available: boolean; reason: string }> {
    let database: IDBDatabase | null = null
    try {
      database = await openDatabase()
      const key = `probe-${crypto.randomUUID()}`
      const write = database.transaction(STORE, 'readwrite')
      write.objectStore(STORE).put(new Blob([Uint8Array.of(1)]), key)
      await transactionDone(write)
      const read = database.transaction(STORE, 'readonly')
      const value = await requestResult(read.objectStore(STORE).get(key))
      if (!(value instanceof Blob) || value.size !== 1) throw new Error('IndexedDB Blob read failed')
      const cleanup = database.transaction(STORE, 'readwrite')
      cleanup.objectStore(STORE).delete(key)
      await transactionDone(cleanup)
      return { available: true, reason: '' }
    } catch (error) { return { available: false, reason: error instanceof Error ? `${error.name}: ${error.message}` : String(error) } }
    finally { database?.close() }
  }

  static async probe(): Promise<boolean> { return (await this.probeWithReason()).available }

  static async create(manifest: TransferManifest): Promise<IndexedDbOpticalSink> {
    return new IndexedDbOpticalSink(await openDatabase(), `transfer-${crypto.randomUUID()}-`, manifest)
  }

  writeBlock(blockId: number, bytes: Uint8Array): Promise<void> {
    if (this.closed || blockId < 0 || blockId >= this.manifest.totalBlocks) throw new Error('Invalid optical block write')
    const expected = Math.min(this.manifest.blockBytes, TRANSFER_MANIFEST_BYTES + this.manifest.archiveBytes - blockId * this.manifest.blockBytes)
    if (bytes.length !== expected) throw new Error('Optical block size mismatch')
    const blob = new Blob([bytes.slice() as BlobPart])
    this.pending = this.pending.then(async () => {
      const transaction = this.database.transaction(STORE, 'readwrite')
      transaction.objectStore(STORE).put(blob, `${this.prefix}${blockId}`)
      await transactionDone(transaction)
    })
    return this.pending
  }

  async finish(): Promise<Blob> {
    await this.pending
    this.closed = true
    const parts: Blob[] = [], hasher = sha256.create()
    let length = 0
    // Read a bounded group of blocks per transaction. A transaction for every
    // small optical block makes final verification needlessly slow on Safari.
    const batchSize = Math.max(1, Math.min(64, Math.floor(4 * 1024 * 1024 / this.manifest.blockBytes)))
    for (let first = 0; first < this.manifest.totalBlocks; first += batchSize) {
      const transaction = this.database.transaction(STORE, 'readonly')
      const store = transaction.objectStore(STORE)
      const requests: Array<Promise<Blob | undefined>> = []
      const last = Math.min(first + batchSize, this.manifest.totalBlocks)
      for (let index = first; index < last; index += 1) requests.push(requestResult(store.get(`${this.prefix}${index}`)) as Promise<Blob | undefined>)
      const [blobs] = await Promise.all([Promise.all(requests), transactionDone(transaction)])
      for (let offset = 0; offset < blobs.length; offset += 1) {
        const index = first + offset, blob = blobs[offset]
        if (!(blob instanceof Blob)) throw new Error(`Missing stored optical block ${index}`)
        const archivePart = index === 0 ? blob.slice(TRANSFER_MANIFEST_BYTES) : blob
        length += archivePart.size
        const reader = archivePart.stream().getReader()
        while (true) { const item = await reader.read(); if (item.done) break; hasher.update(item.value) }
        parts.push(archivePart)
      }
    }
    if (length !== this.manifest.archiveBytes) throw new Error('Optical ZIP length mismatch')
    const digest = hasher.digest()
    if (!digest.every((value, index) => value === this.manifest.sha256[index])) throw new Error('SHA-256 mismatch; transfer not verified')
    return new Blob(parts, { type: 'application/zip' })
  }

  async remove(): Promise<void> {
    try {
      await this.pending.catch(() => {})
      for (let index = 0; index < this.manifest.totalBlocks; index += 256) {
        const transaction = this.database.transaction(STORE, 'readwrite')
        const store = transaction.objectStore(STORE)
        for (let end = Math.min(index + 256, this.manifest.totalBlocks), item = index; item < end; item += 1) store.delete(`${this.prefix}${item}`)
        await transactionDone(transaction)
      }
    } finally { this.database.close() }
  }
}
