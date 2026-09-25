import { opticalPaceFps } from '../../optical-core/src/pacing.ts'

/** Audio feedback changes the display hold, never the optical frame clock. */
export class AudioPaceController {
  currentFps: number
  private lastChangeAt = -Infinity
  private direction = 0
  private consistentReports = 0

  constructor(initialFps: number) { this.currentFps = initialFps }

  update(code: number, now: number, beforeTransmission: boolean) {
    const requestedFps = opticalPaceFps(code)
    if (!requestedFps) return false
    if (beforeTransmission) {
      const changed = requestedFps !== this.currentFps
      this.currentFps = requestedFps
      this.lastChangeAt = now
      this.direction = 0; this.consistentReports = 0
      return changed
    }
    const direction = Math.sign(requestedFps - this.currentFps)
    if (!direction) { this.direction = 0; this.consistentReports = 0; return false }
    this.consistentReports = direction === this.direction ? this.consistentReports + 1 : 1
    this.direction = direction
    const requiredReports = direction < 0 ? 2 : 3
    const minimumInterval = direction < 0 ? 4000 : 12000
    if (this.consistentReports < requiredReports || now - this.lastChangeAt < minimumInterval) return false
    this.currentFps = requestedFps
    this.lastChangeAt = now
    this.direction = 0; this.consistentReports = 0
    return true
  }
}
