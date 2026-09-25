/** Rotate each block's shard order to break display/camera phase locking. */
export class RotatingShardOrder {
  private readonly visits = new Map<number, number>()
  private previousBlock = -1
  private offset = 0
  private readonly symbolsPerBlock: number
  constructor(symbolsPerBlock: number) {
    if (symbolsPerBlock !== 10) throw new Error('Shard rotation expects eight source and two repair symbols')
    this.symbolsPerBlock = symbolsPerBlock
  }

  index(blockId: number, frameId: number): number {
    if (blockId !== this.previousBlock || frameId % this.symbolsPerBlock === 0) {
      const visit = this.visits.get(blockId) || 0
      this.visits.set(blockId, visit + 1)
      this.offset = (visit * 3) % this.symbolsPerBlock
      this.previousBlock = blockId
    }
    return (frameId % this.symbolsPerBlock + this.offset) % this.symbolsPerBlock
  }
}
