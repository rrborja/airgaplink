/** Reed–Solomon erasure blocks for the local optical path. The WASM engine is
 * supplied by the browser or test harness; no encoded file bytes enter APIs. */
export interface ErasureEngine {
  encode(shards: Uint8Array, dataShards: number, parityShards: number): number
  reconstruct(shards: Uint8Array, dataShards: number, parityShards: number, available: boolean[]): number
}

export interface AvailableSymbol { index: number; bytes: Uint8Array }
export interface EncodedBlock { sourceCount: number; repairCount: number; shardBytes: number; sourceBytes: number; symbols: Uint8Array[] }

export class ReedSolomonBlockCodec {
  private readonly engine: ErasureEngine
  constructor(engine: ErasureEngine) { this.engine = engine }

  encode(source: Uint8Array, shardBytes: number, sourceCount = 8, repairCount = 2): EncodedBlock {
    if (shardBytes < 1 || sourceCount < 1 || repairCount < 1 || sourceCount + repairCount > 256 || source.length > shardBytes * sourceCount) throw new Error('Invalid erasure block dimensions')
    const shards = new Uint8Array(shardBytes * (sourceCount + repairCount))
    shards.set(source)
    const result = this.engine.encode(shards, sourceCount, repairCount)
    if (result !== 0) throw new Error(`Reed–Solomon encode failed: ${result}`)
    return { sourceCount, repairCount, shardBytes, sourceBytes: source.length, symbols: Array.from({ length: sourceCount + repairCount }, (_, index) => shards.slice(index * shardBytes, (index + 1) * shardBytes)) }
  }

  recover(availableSymbols: AvailableSymbol[], sourceCount: number, repairCount: number, shardBytes: number, sourceBytes: number): Uint8Array | null {
    const total = sourceCount + repairCount
    if (sourceCount < 1 || repairCount < 1 || total > 256 || shardBytes < 1 || sourceBytes < 0 || sourceBytes > sourceCount * shardBytes) return null
    const shards = new Uint8Array(total * shardBytes), available = Array<boolean>(total).fill(false)
    for (const symbol of availableSymbols) {
      if (!Number.isInteger(symbol.index) || symbol.index < 0 || symbol.index >= total || symbol.bytes.length !== shardBytes || available[symbol.index]) continue
      shards.set(symbol.bytes, symbol.index * shardBytes); available[symbol.index] = true
    }
    if (available.filter(Boolean).length < sourceCount) return null
    if (!available.slice(0, sourceCount).every(Boolean)) {
      if (this.engine.reconstruct(shards, sourceCount, repairCount, available) !== 0) return null
    }
    return shards.slice(0, sourceBytes)
  }
}

const SYMBOL_MAGIC = 0x4f53 // OS
export const SYMBOL_HEADER_BYTES = 16
export interface OpticalSymbol { transferId: number; blockId: number; index: number; sourceCount: number; repairCount: number; sourceBytes: number; bytes: Uint8Array }

export function packOpticalSymbol(symbol: OpticalSymbol) {
  if (symbol.index >= symbol.sourceCount + symbol.repairCount || symbol.sourceBytes > 65535) throw new Error('Invalid optical symbol')
  const packet = new Uint8Array(SYMBOL_HEADER_BYTES + symbol.bytes.length), view = new DataView(packet.buffer)
  view.setUint16(0, SYMBOL_MAGIC)
  packet[2] = 1
  packet[3] = symbol.index
  view.setUint32(4, symbol.transferId)
  view.setUint32(8, symbol.blockId)
  packet[12] = symbol.sourceCount
  packet[13] = symbol.repairCount
  view.setUint16(14, symbol.sourceBytes)
  packet.set(symbol.bytes, SYMBOL_HEADER_BYTES)
  return packet
}

export function unpackOpticalSymbol(packet: Uint8Array): OpticalSymbol | null {
  if (packet.length <= SYMBOL_HEADER_BYTES) return null
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength)
  if (view.getUint16(0) !== SYMBOL_MAGIC || packet[2] !== 1) return null
  const index = packet[3], sourceCount = packet[12], repairCount = packet[13], sourceBytes = view.getUint16(14)
  if (!sourceCount || !repairCount || index >= sourceCount + repairCount || sourceBytes > sourceCount * (packet.length - SYMBOL_HEADER_BYTES)) return null
  return { transferId: view.getUint32(4), blockId: view.getUint32(8), index, sourceCount, repairCount, sourceBytes, bytes: packet.slice(SYMBOL_HEADER_BYTES) }
}

/** One bounded block at a time; duplicate optical frames are harmless. */
export class OpticalBlockCollector {
  private readonly symbols = new Map<number, Uint8Array>()
  private parameters: string | null = null
  private readonly codec: ReedSolomonBlockCodec
  readonly transferId: number
  readonly blockId: number
  constructor(codec: ReedSolomonBlockCodec, transferId: number, blockId: number) { this.codec = codec; this.transferId = transferId; this.blockId = blockId }
  add(symbol: OpticalSymbol): Uint8Array | null {
    if (symbol.transferId !== this.transferId || symbol.blockId !== this.blockId) return null
    const parameters = `${symbol.sourceCount}:${symbol.repairCount}:${symbol.sourceBytes}:${symbol.bytes.length}`
    if (this.parameters && this.parameters !== parameters) return null
    this.parameters = parameters
    if (!this.symbols.has(symbol.index)) this.symbols.set(symbol.index, symbol.bytes)
    return this.codec.recover([...this.symbols].map(([index, bytes]) => ({ index, bytes })), symbol.sourceCount, symbol.repairCount, symbol.bytes.length, symbol.sourceBytes)
  }
  get count() { return this.symbols.size }
}

export const TRANSFER_MANIFEST_BYTES = 56
export interface TransferManifest { transferId: number; archiveBytes: number; blockBytes: number; totalBlocks: number; sha256: Uint8Array }
export function packTransferManifest(manifest: TransferManifest) {
  if (manifest.sha256.length !== 32 || !Number.isSafeInteger(manifest.archiveBytes) || manifest.archiveBytes < 0) throw new Error('Invalid transfer manifest')
  const bytes = new Uint8Array(TRANSFER_MANIFEST_BYTES), view = new DataView(bytes.buffer)
  bytes.set([79, 77, 84, 49]) // OMT1
  view.setUint32(4, manifest.transferId)
  view.setBigUint64(8, BigInt(manifest.archiveBytes))
  view.setUint32(16, manifest.blockBytes)
  view.setUint32(20, manifest.totalBlocks)
  bytes.set(manifest.sha256, 24)
  return bytes
}

export function unpackTransferManifest(bytes: Uint8Array): TransferManifest | null {
  if (bytes.length < TRANSFER_MANIFEST_BYTES || bytes[0] !== 79 || bytes[1] !== 77 || bytes[2] !== 84 || bytes[3] !== 49) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const archiveBytes = Number(view.getBigUint64(8)), blockBytes = view.getUint32(16), totalBlocks = view.getUint32(20)
  if (!Number.isSafeInteger(archiveBytes) || blockBytes < TRANSFER_MANIFEST_BYTES || totalBlocks !== Math.ceil((TRANSFER_MANIFEST_BYTES + archiveBytes) / blockBytes)) return null
  return { transferId: view.getUint32(4), archiveBytes, blockBytes, totalBlocks, sha256: bytes.slice(24, 56) }
}
