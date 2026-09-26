import { BINARY_200_REPEATED_MAX_BYTES, BINARY_PROFILE, DEBUG_PROFILE, WIDE_BINARY_PROFILE, binaryRepeatedPayloadCapacity, framePayloadCapacity, SYMBOL_HEADER_BYTES } from '../../optical-core/src/index.ts'
import { opticalShardBytes } from './optical-shard-size.ts'

const binaryBytes = opticalShardBytes(BINARY_PROFILE)
if (binaryBytes !== 984 || binaryBytes + SYMBOL_HEADER_BYTES !== BINARY_200_REPEATED_MAX_BYTES || binaryBytes + SYMBOL_HEADER_BYTES > framePayloadCapacity(BINARY_PROFILE)) throw new Error('200×120 binary shard did not fill the triplicated data grid')
const wideBytes = opticalShardBytes(WIDE_BINARY_PROFILE)
if (wideBytes !== 1184 || wideBytes + SYMBOL_HEADER_BYTES !== binaryRepeatedPayloadCapacity(WIDE_BINARY_PROFILE)) throw new Error('240×120 binary shard did not fill the triplicated data grid')
if (opticalShardBytes(DEBUG_PROFILE) !== Math.floor((framePayloadCapacity(DEBUG_PROFILE) - SYMBOL_HEADER_BYTES) / 32) * 32) throw new Error('Existing 100×60 profile capacity changed')
console.log(JSON.stringify({ result: 'ok', binaryBytes, wideBytes }))
