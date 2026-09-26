import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { ReedSolomonErasure } from '@digitaldefiance/reed-solomon-erasure.wasm/browser'
import { BINARY_PROFILE, DEBUG_PROFILE, DENSE_BINARY_PROFILE, RGB4_200_PROFILE, WIDE_BINARY_PROFILE, binaryRepeatedPayloadCapacity, decodeOpticalCells, deterministicPayload, encodeOpticalFrame, framePayloadCapacity } from './index.ts'
import { OpticalBlockCollector, ReedSolomonBlockCodec, SYMBOL_HEADER_BYTES, TRANSFER_MANIFEST_BYTES, packOpticalSymbol, packTransferManifest, unpackOpticalSymbol, unpackTransferManifest } from './fec.ts'

const engine = ReedSolomonErasure.fromBytes(readFileSync(new URL(import.meta.resolve('@digitaldefiance/reed-solomon-erasure.wasm/wasm'))))
const codec = new ReedSolomonBlockCodec(engine)
const wasmBytes = readFileSync(new URL(import.meta.resolve('@digitaldefiance/reed-solomon-erasure.wasm/wasm')))
const archive = deterministicPayload(0x2042, 34000), hash = createHash('sha256').update(archive).digest()
const shardBytes = framePayloadCapacity(DEBUG_PROFILE) - SYMBOL_HEADER_BYTES, blockBytes = 8 * shardBytes - 1
const totalBlocks = Math.ceil((TRANSFER_MANIFEST_BYTES + archive.length) / blockBytes), transferId = 0x4125abcd
const source = new Uint8Array(TRANSFER_MANIFEST_BYTES + archive.length)
source.set(packTransferManifest({ transferId, archiveBytes: archive.length, blockBytes, totalBlocks, sha256: hash })); source.set(archive, TRANSFER_MANIFEST_BYTES)
const recoveredBlocks = new Map<number, Uint8Array>()
let frameId = 0, dropped = 0
for (let blockId = 0; blockId < totalBlocks; blockId += 1) {
  const block = codec.encode(source.subarray(blockId * blockBytes, Math.min((blockId + 1) * blockBytes, source.length)), shardBytes)
  const receiverCodec = new ReedSolomonBlockCodec(ReedSolomonErasure.fromBytes(wasmBytes))
  const collector = new OpticalBlockCollector(receiverCodec, transferId, blockId)
  for (let index = 0; index < block.symbols.length; index += 1) {
    if (index === blockId % 8 || index === (blockId + 3) % 8) { dropped += 1; frameId += 1; continue }
    const packet = packOpticalSymbol({ transferId, blockId, index, sourceCount: 8, repairCount: 2, sourceBytes: block.sourceBytes, bytes: block.symbols[index] })
    const encoded = encodeOpticalFrame(packet, frameId++, blockId)
    const decoded = decodeOpticalCells(encoded.cells)
    if (!decoded.ok) throw new Error('Valid optical frame failed')
    const symbol = unpackOpticalSymbol(decoded.payload)
    if (!symbol) throw new Error('Valid optical symbol failed')
    const recovered = collector.add(symbol)
    if (recovered) recoveredBlocks.set(blockId, recovered)
  }
  if (!recoveredBlocks.has(blockId)) throw new Error(`Block ${blockId} failed with ${collector.count} symbols`)
}
const manifest = unpackTransferManifest(recoveredBlocks.get(0)!)
if (!manifest || manifest.transferId !== transferId || recoveredBlocks.size !== totalBlocks) throw new Error('Transfer manifest or FEC blocks missing')
const result = new Uint8Array(archive.length)
let cursor = 0
for (let blockId = 0; blockId < totalBlocks; blockId += 1) {
  const recovered = recoveredBlocks.get(blockId)!
  const bytes = blockId === 0 ? recovered.subarray(TRANSFER_MANIFEST_BYTES) : recovered
  result.set(bytes, cursor); cursor += bytes.length
}
if (cursor !== archive.length || !createHash('sha256').update(result).digest().equals(hash)) throw new Error('Final optical archive hash mismatch')
// Both binary profiles fill their data grids with three spatial copies. Verify
// their non-32-aligned FEC shard sizes through framing and erasure recovery.
for (const binaryProfile of [BINARY_PROFILE, WIDE_BINARY_PROFILE, DENSE_BINARY_PROFILE]) {
  const packetBytes = binaryRepeatedPayloadCapacity(binaryProfile), binaryShardBytes = packetBytes - SYMBOL_HEADER_BYTES
  const binarySource = deterministicPayload(0x5511, 8 * binaryShardBytes - 1)
  const binaryBlock = codec.encode(binarySource, binaryShardBytes)
  const binaryCollector = new OpticalBlockCollector(new ReedSolomonBlockCodec(ReedSolomonErasure.fromBytes(wasmBytes)), transferId, 0)
  let binaryRecovered: Uint8Array | null = null
  for (let index = 0; index < binaryBlock.symbols.length; index += 1) {
    if (index === 1 || index === 6) continue
    const packet = packOpticalSymbol({ transferId, blockId: 0, index, sourceCount: 8, repairCount: 2, sourceBytes: binaryBlock.sourceBytes, bytes: binaryBlock.symbols[index] })
    if (packet.length !== packetBytes) throw new Error('Binary packet did not fill triplicated grid')
    const frame = encodeOpticalFrame(packet, 100 + index, 0, binaryProfile)
    frame.cells[16 * frame.width + 16] ^= 1
    const decoded = decodeOpticalCells(frame.cells, binaryProfile)
    if (!decoded.ok || decoded.recovery !== 'spatial-copy') throw new Error('Full-grid binary frame did not recover damaged first copy')
    const symbol = unpackOpticalSymbol(decoded.payload)
    if (!symbol) throw new Error('Full-grid binary symbol failed')
    binaryRecovered = binaryCollector.add(symbol) || binaryRecovered
  }
  if (!binaryRecovered || binaryRecovered.some((value, index) => value !== binarySource[index])) throw new Error('Full-grid binary FEC block failed')
}
// RGB's lower effective payload capacity must still fit the unchanged optical
// symbol/FEC path. Corrupt one spatial copy in every received RGB frame.
const rgbArchive = deterministicPayload(0x8877, 22000), rgbHash = createHash('sha256').update(rgbArchive).digest()
const rgbShardBytes = Math.floor((framePayloadCapacity(RGB4_200_PROFILE) - SYMBOL_HEADER_BYTES) / 32) * 32
const rgbBlockBytes = 8 * rgbShardBytes - 1, rgbBlocks = Math.ceil((TRANSFER_MANIFEST_BYTES + rgbArchive.length) / rgbBlockBytes)
const rgbSource = new Uint8Array(TRANSFER_MANIFEST_BYTES + rgbArchive.length), rgbTransferId = 0x5823bc76
rgbSource.set(packTransferManifest({ transferId: rgbTransferId, archiveBytes: rgbArchive.length, blockBytes: rgbBlockBytes, totalBlocks: rgbBlocks, sha256: rgbHash })); rgbSource.set(rgbArchive, TRANSFER_MANIFEST_BYTES)
const rgbRecovered = new Map<number, Uint8Array>()
for (let blockId = 0; blockId < rgbBlocks; blockId += 1) {
  const block = codec.encode(rgbSource.subarray(blockId * rgbBlockBytes, Math.min((blockId + 1) * rgbBlockBytes, rgbSource.length)), rgbShardBytes)
  const collector = new OpticalBlockCollector(new ReedSolomonBlockCodec(ReedSolomonErasure.fromBytes(wasmBytes)), rgbTransferId, blockId)
  for (let index = 0; index < block.symbols.length; index += 1) {
    if (index === 2 || index === 5) continue
    const packet = packOpticalSymbol({ transferId: rgbTransferId, blockId, index, sourceCount: 8, repairCount: 2, sourceBytes: block.sourceBytes, bytes: block.symbols[index] })
    const frame = encodeOpticalFrame(packet, blockId * 20 + index, blockId, RGB4_200_PROFILE)
    for (let dy = 0; dy < 2; dy += 1) for (let dx = 0; dx < 2; dx += 1) frame.cells[(16 + dy) * frame.width + 16 + dx] ^= 3
    const decoded = decodeOpticalCells(frame.cells, RGB4_200_PROFILE)
    if (!decoded.ok || decoded.recovery !== 'spatial-copy') throw new Error('RGB data frame did not recover its damaged first copy')
    const symbol = unpackOpticalSymbol(decoded.payload)
    if (!symbol) throw new Error('Recovered RGB optical symbol invalid')
    const recovered = collector.add(symbol)
    if (recovered) rgbRecovered.set(blockId, recovered)
  }
  if (!rgbRecovered.has(blockId)) throw new Error(`RGB FEC block ${blockId} was not reconstructed`)
}
const rgbManifest = unpackTransferManifest(rgbRecovered.get(0)!)
if (!rgbManifest || rgbManifest.archiveBytes !== rgbArchive.length || rgbManifest.totalBlocks !== rgbBlocks) throw new Error('RGB manifest failed')
const rgbResult = new Uint8Array(rgbArchive.length)
let rgbCursor = 0
for (let blockId = 0; blockId < rgbBlocks; blockId += 1) {
  const bytes = blockId === 0 ? rgbRecovered.get(blockId)!.subarray(TRANSFER_MANIFEST_BYTES) : rgbRecovered.get(blockId)!
  rgbResult.set(bytes, rgbCursor); rgbCursor += bytes.length
}
if (rgbCursor !== rgbArchive.length || !createHash('sha256').update(rgbResult).digest().equals(rgbHash)) throw new Error('RGB optical archive hash mismatch')
console.log(JSON.stringify({ result: 'ok', archiveBytes: archive.length, blocks: totalBlocks, droppedFrames: dropped, sha256Verified: true }))
