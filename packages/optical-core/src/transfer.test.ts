import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { ReedSolomonErasure } from '@digitaldefiance/reed-solomon-erasure.wasm/browser'
import { DEBUG_PROFILE, decodeOpticalCells, deterministicPayload, encodeOpticalFrame, framePayloadCapacity } from './index.ts'
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
console.log(JSON.stringify({ result: 'ok', archiveBytes: archive.length, blocks: totalBlocks, droppedFrames: dropped, sha256Verified: true }))
