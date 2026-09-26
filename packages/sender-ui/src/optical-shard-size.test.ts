import { BINARY_PROFILE, DEBUG_PROFILE, framePayloadCapacity, SYMBOL_HEADER_BYTES } from '../../optical-core/src/index.ts'
import { opticalShardBytes } from './optical-shard-size.ts'

const binaryBytes = opticalShardBytes(BINARY_PROFILE)
if (binaryBytes !== 768 || binaryBytes + SYMBOL_HEADER_BYTES > framePayloadCapacity(BINARY_PROFILE)) throw new Error('200×120 binary shard did not use the bounded physical size')
if (opticalShardBytes(DEBUG_PROFILE) !== Math.floor((framePayloadCapacity(DEBUG_PROFILE) - SYMBOL_HEADER_BYTES) / 32) * 32) throw new Error('Existing 100×60 profile capacity changed')
console.log(JSON.stringify({ result: 'ok', binaryBytes }))
