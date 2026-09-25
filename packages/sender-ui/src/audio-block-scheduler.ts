/** Repeat the manifest, then keep a small set of incomplete blocks in view. */
export class AudioBlockScheduler {
  private activeBlock = 0
  private lastFrameId = -1
  private readonly symbolsPerBlock: number
  private readonly windowSize: number
  constructor(symbolsPerBlock: number, windowSize = 4) { this.symbolsPerBlock = symbolsPerBlock; this.windowSize = windowSize }

  next(frameId: number, totalBlocks: number, acknowledged: ReadonlySet<number>): number {
    // A block read is asynchronous. The display loop may call next() many
    // times with the same frame ID while waiting for bytes; a batch boundary
    // must advance only after an optical frame was actually rendered.
    const newFrame = frameId !== this.lastFrameId
    this.lastFrameId = frameId
    let firstPending = 0
    while (firstPending < totalBlocks && acknowledged.has(firstPending)) firstPending += 1
    if (firstPending >= totalBlocks) return -1
    if (firstPending === 0) return (this.activeBlock = 0)

    const batchStart = 1 + Math.floor((firstPending - 1) / this.windowSize) * this.windowSize
    const windowEnd = Math.min(totalBlocks, batchStart + this.windowSize)
    if (this.activeBlock < batchStart || this.activeBlock >= windowEnd || acknowledged.has(this.activeBlock) || (newFrame && frameId % this.symbolsPerBlock === 0)) {
      this.activeBlock = this.activeBlock + 1 < windowEnd && this.activeBlock >= batchStart ? this.activeBlock + 1 : batchStart
      while (acknowledged.has(this.activeBlock) && this.activeBlock < windowEnd) this.activeBlock += 1
      if (this.activeBlock >= windowEnd) this.activeBlock = firstPending
    }
    return this.activeBlock
  }
}
