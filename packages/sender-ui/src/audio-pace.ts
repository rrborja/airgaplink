import { AUDIO_PACE_FPS, opticalPaceFps } from '../../optical-core/src/pacing.ts'

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
    const requiredReports = 2
    const minimumInterval = direction < 0 ? 3000 : 5000
    if (this.consistentReports < requiredReports || now - this.lastChangeAt < minimumInterval) return false
    const currentIndex = AUDIO_PACE_FPS.findIndex(fps => fps >= this.currentFps)
    const requestedIndex = AUDIO_PACE_FPS.indexOf(requestedFps as typeof AUDIO_PACE_FPS[number])
    this.currentFps = AUDIO_PACE_FPS[Math.max(1, Math.min(AUDIO_PACE_FPS.length - 1, currentIndex + Math.sign(requestedIndex - currentIndex)))]
    this.lastChangeAt = now
    this.direction = 0; this.consistentReports = 0
    return true
  }
}
