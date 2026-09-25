import { readFileSync } from 'node:fs'
import { ReedSolomonErasure } from '@digitaldefiance/reed-solomon-erasure.wasm/browser'
import { OpticalBlockCollector, ReedSolomonBlockCodec, packOpticalSymbol, unpackOpticalSymbol } from './fec.ts'
import { deterministicPayload } from './index.ts'

const wasm = readFileSync(new URL(import.meta.resolve('@digitaldefiance/reed-solomon-erasure.wasm/wasm')))
const codec = new ReedSolomonBlockCodec(ReedSolomonErasure.fromBytes(wasm))
const source = deterministicPayload(88, 8 * 512 - 17)
const block = codec.encode(source, 512, 8, 2)
const collector = new OpticalBlockCollector(codec, 0x91e8713a, 4)
let recovered: Uint8Array | null = null
for (const index of [0, 2, 3, 4, 6, 7, 8, 9]) {
  const packed = packOpticalSymbol({ transferId: 0x91e8713a, blockId: 4, index, sourceCount: block.sourceCount, repairCount: block.repairCount, sourceBytes: block.sourceBytes, bytes: block.symbols[index] })
  const unpacked = unpackOpticalSymbol(packed)
  if (!unpacked) throw new Error('Optical symbol packet failed to decode')
  recovered = collector.add(unpacked)
}
if (!recovered || !recovered.every((value, index) => value === source[index])) throw new Error('Reed–Solomon block recovery failed after two source erasures')
if (collector.count !== 8) throw new Error('Collector double-counted optical symbols')
console.log(JSON.stringify({ result: 'ok', sourceBytes: source.length, lostSourceSymbols: 2, repairSymbols: 2 }))
