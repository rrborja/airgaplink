export interface CompactBlockStatus { firstMissing: number; bitmap: number }

/** A cumulative ACK repairs any earlier compact status tone the mic missed. */
export function applyCompactBlockStatus(acknowledged: Set<number>, previousFloor: number, totalBlocks: number, status: CompactBlockStatus) {
  const floor = Math.min(status.firstMissing, totalBlocks)
  for (let index = previousFloor; index < floor; index += 1) acknowledged.add(index)
  for (let bit = 0; bit < 4; bit += 1) if ((status.bitmap >>> bit) & 1) {
    const index = status.firstMissing + bit
    if (index < totalBlocks) acknowledged.add(index)
  }
  return Math.max(previousFloor, floor)
}
