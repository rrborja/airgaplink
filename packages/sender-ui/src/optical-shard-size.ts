import { framePayloadCapacity, SYMBOL_HEADER_BYTES, type OpticalProfile } from '../../optical-core/src/index.ts'

/** A dense 200×120 binary frame has nearly 3 KB of CRC-covered payload.
 * Physical Safari testing showed zero valid file frames at that length even
 * while 73-byte handshake frames decoded. Keep the existing on-wire format,
 * but use only the reliable upper part of the grid for each FEC shard. */
export function opticalShardBytes(profile: OpticalProfile) {
  const capacity = Math.floor((framePayloadCapacity(profile) - SYMBOL_HEADER_BYTES) / 32) * 32
  return profile.id === 'binary-200x120' ? Math.min(capacity, 768) : capacity
}
