/** Session-local mirror of blocks whose sink writes have completed. The sink
 * holds the durable bytes; this sparse bitmap is updated only after a write
 * resolves, never merely because a shard or a block decoded. */
export class ReceivedBlockMap {
  private readonly words = new Map<number, number>()
  private total = 0
  private completed = 0
  private floor = 0

  configure(totalBlocks: number) {
    if (this.total || this.completed || !Number.isInteger(totalBlocks) || totalBlocks < 1 || totalBlocks > 0xffffffff) throw new Error('Invalid received-block map size')
    this.total = totalBlocks
  }
  get size() { return this.completed }
  get totalBlocks() { return this.total }
  get missingCount() { return Math.max(0, this.total - this.completed) }
  has(blockId: number) {
    if (!Number.isInteger(blockId) || blockId < 0 || blockId >= this.total) return false
    return !!((this.words.get(Math.floor(blockId / 32)) || 0) & (1 << (blockId % 32)))
  }
  add(blockId: number) {
    if (!Number.isInteger(blockId) || blockId < 0 || blockId >= this.total) throw new Error('Invalid received block ID')
    if (this.has(blockId)) return false
    const word = Math.floor(blockId / 32)
    this.words.set(word, ((this.words.get(word) || 0) | (1 << (blockId % 32))) >>> 0)
    this.completed += 1
    if (blockId === this.floor) while (this.floor < this.total && this.has(this.floor)) this.floor += 1
    return true
  }
  firstMissing() { return this.floor }
  /** Rotating 32-block window; a lost report merely delays prioritization. */
  nextMissingWindow(cursor = 0) {
    if (!this.total) return null
    const count = Math.ceil(this.total / 32), first = Number.isInteger(cursor) && cursor >= 0 ? cursor % count : 0
    for (let step = 0; step < count; step += 1) {
      const word = (first + step) % count, base = word * 32, valid = Math.min(32, this.total - base)
      const validMask = valid === 32 ? 0xffffffff : (2 ** valid - 1) >>> 0
      const missingMask = (~(this.words.get(word) || 0) & validMask) >>> 0
      if (missingMask) return { windowBase: base, missingMask, nextCursor: (word + 1) % count }
    }
    return null
  }
}
