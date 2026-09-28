import { binaryRepeatedPayloadCapacity, framePayloadCapacity, SYMBOL_HEADER_BYTES, type OpticalProfile } from '../../optical-core/src/index.ts'

/** Keep three spatial copies on supported binary frames. Fill the data grid
 * exactly, without the two pseudo-random filler bands between copies. This
 * remains far shorter than the nearly 3 KB single-copy packet that failed in
 * physical Safari testing; the larger triplicated packet still needs a live
 * throughput comparison against the previous 784-byte packet. */
export function opticalShardBytes(profile: OpticalProfile, phoneSafe = false) {
  const repeatedCapacity = binaryRepeatedPayloadCapacity(profile)
  if (repeatedCapacity) return phoneSafe && profile.id === 'binary-320x180' ? Math.min(784, repeatedCapacity - SYMBOL_HEADER_BYTES) : repeatedCapacity - SYMBOL_HEADER_BYTES
  const capacity = Math.floor((framePayloadCapacity(profile) - SYMBOL_HEADER_BYTES) / 32) * 32
  return capacity
}
