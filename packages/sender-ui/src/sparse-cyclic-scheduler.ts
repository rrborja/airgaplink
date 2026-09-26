export interface SparseSelection { blockId: number; hinted: boolean; cycleCount: number; visit: number }
export interface MissingHint { windowBase: number; missingMask: number; completedCount: number }

/** Optical blocks never wait for ACKs. Each visit emits every FEC shard;
 * sequential visits always continue, so losing every acoustic hint cannot
 * prevent eventual completion. Hints only insert bounded extra visits. */
export class SparseCyclicScheduler {
  private cursor = 0
  private active: SparseSelection | null = null
  private framesInVisit = 0
  private cycles = 0
  private wrapPending = false
  private sequentialSinceHint = 0
  private hintCursor = 0
  private readonly hints = new Map<number, number>()
  private readonly visits = new Map<number, number>()
  private completedEstimate = 0
  private hinted = 0
  private emitted = 0
  private readonly symbolsPerBlock: number
  private readonly maxHints: number
  constructor(symbolsPerBlock: number, maxHints = 128) {
    if (!Number.isInteger(symbolsPerBlock) || symbolsPerBlock < 1 || !Number.isInteger(maxHints) || maxHints < 1) throw new Error('Invalid sparse scheduler')
    this.symbolsPerBlock = symbolsPerBlock; this.maxHints = maxHints
  }
  get metrics() { return { cycleCount: this.cycles, hintedRetransmissions: this.hinted, emittedFrames: this.emitted, completedEstimate: this.completedEstimate, pendingHints: this.hints.size } }

  addHint(hint: MissingHint, totalBlocks: number, now: number) {
    if (!Number.isInteger(totalBlocks) || totalBlocks < 1 || !Number.isFinite(now) || !Number.isInteger(hint.completedCount) || hint.completedCount < 0 || hint.completedCount > totalBlocks || !Number.isInteger(hint.windowBase) || hint.windowBase < 0 || hint.windowBase >= totalBlocks || hint.windowBase % 32 || !Number.isInteger(hint.missingMask) || hint.missingMask <= 0 || hint.missingMask > 0xffffffff) return false
    const validBits = Math.min(32, totalBlocks - hint.windowBase)
    const validMask = validBits === 32 ? 0xffffffff : (2 ** validBits - 1) >>> 0
    if ((hint.missingMask & ~validMask) !== 0) return false
    this.completedEstimate = Math.max(this.completedEstimate, hint.completedCount)
    for (let bit = 0; bit < 32; bit += 1) if ((hint.missingMask >>> bit) & 1) {
      const id = hint.windowBase + bit
      if (id < totalBlocks) this.hints.set(id, now + 30_000)
    }
    while (this.hints.size > this.maxHints) this.hints.delete(this.hints.keys().next().value!)
    return true
  }

  private nextHint(totalBlocks: number, now: number) {
    for (const [id, expiry] of this.hints) if (expiry <= now || id >= totalBlocks) this.hints.delete(id)
    const ids = [...this.hints.keys()]
    if (!ids.length) return null
    for (let offset = 0; offset < ids.length; offset += 1) {
      const id = ids[(this.hintCursor + offset) % ids.length]
      if (id !== this.cursor) { this.hintCursor = (this.hintCursor + offset + 1) % ids.length; return id }
    }
    return null
  }

  select(totalBlocks: number, now: number): SparseSelection {
    if (!Number.isInteger(totalBlocks) || totalBlocks < 1 || !Number.isFinite(now)) throw new Error('Invalid cyclic transfer size')
    if (this.active) return this.active
    const completion = this.completedEstimate / totalBlocks
    const sequentialInterval = completion >= 0.98 ? 1 : completion >= 0.9 ? 2 : 4
    const hintedId = completion >= 0.75 && this.sequentialSinceHint >= sequentialInterval ? this.nextHint(totalBlocks, now) : null
    if (hintedId !== null) {
      this.active = { blockId: hintedId, hinted: true, cycleCount: this.cycles, visit: this.visits.get(hintedId) || 0 }
      this.visits.set(hintedId, this.active.visit + 1)
      this.sequentialSinceHint = 0; this.hinted += 1
    } else {
      this.active = { blockId: this.cursor, hinted: false, cycleCount: this.cycles, visit: this.visits.get(this.cursor) || 0 }
      this.visits.set(this.cursor, this.active.visit + 1)
      this.cursor += 1; this.sequentialSinceHint += 1
      if (this.cursor >= totalBlocks) { this.cursor = 0; this.wrapPending = true }
    }
    return this.active
  }

  /** Call only after an optical frame was actually rendered. */
  frameEmitted() {
    if (!this.active) throw new Error('No selected optical block')
    this.emitted += 1; this.framesInVisit += 1
    if (this.framesInVisit === this.symbolsPerBlock) {
      if (this.wrapPending) { this.cycles += 1; this.wrapPending = false }
      this.framesInVisit = 0; this.active = null
    }
  }

  /** A paused/recreated renderer starts the active visit from shard zero.
   * The sender re-encrypts it with a fresh wire visit counter. */
  restartVisit() { if (this.active) this.framesInVisit = 0 }
}
