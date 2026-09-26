import type { OpticalProfile } from './index.ts'

// Code zero means no measurement yet. The other codes fit in one control
// packet nibble, so optical pacing does not lengthen acoustic feedback.
export const AUDIO_PACE_FPS = [0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 24, 30, 45, 60] as const

export function opticalPaceFps(code: number) {
  return Number.isInteger(code) && code >= 0 && code < AUDIO_PACE_FPS.length ? AUDIO_PACE_FPS[code] : 0
}

export function recommendOpticalPaceCode(profile: OpticalProfile, processedFps: number, validFps: number) {
  if (!Number.isFinite(processedFps) || processedFps < 1 || !Number.isFinite(validFps) || validFps < 0) return 0
  const ratio = Math.min(1, validFps / processedFps)
  const reliability = ratio < 0.35 ? 0.5 : ratio < 0.7 ? 0.75 : 1
  const target = Math.max(1, Math.min(profile.targetDisplayFps, processedFps * 0.8 * reliability))
  for (let code = AUDIO_PACE_FPS.length - 1; code > 0; code -= 1) if (AUDIO_PACE_FPS[code] <= target) return code
  return 1
}

export interface OpticalPaceWindow {
  processedFrames: number
  validFrames: number
  uniqueFrames: number
  usefulShards: number
  usefulShardBytes: number
  storedBytes: number
  observedSenderFps: number
  spanSeconds: number
}

/** Compare productive throughput at adjacent display rates. CRC failures are
 * diagnostic, not a reason to slow down when more distinct FEC data arrives. */
export class AdaptiveOpticalPace {
  private lastChangeAt = -Infinity
  private readonly maxCode: number
  private probe: { previousCode: number; baselineBytesPerSecond: number; requestedAt: number; observedAt: number | null } | null = null
  private rejectedCode = 0
  private retryRejectedAt = -Infinity
  private nextDownProbeAt = 0
  currentCode: number

  constructor(profile: OpticalProfile, initialCode: number) {
    let maxCode = 1
    for (let code = 1; code < AUDIO_PACE_FPS.length; code += 1) if (AUDIO_PACE_FPS[code] <= profile.targetDisplayFps) maxCode = code
    this.maxCode = maxCode
    this.currentCode = Math.max(1, Math.min(this.maxCode, initialCode))
  }

  update(window: OpticalPaceWindow, now: number) {
    const { processedFrames, validFrames, uniqueFrames, usefulShards, usefulShardBytes, storedBytes, observedSenderFps, spanSeconds } = window
    if (![now, spanSeconds, usefulShards, usefulShardBytes, storedBytes, observedSenderFps].every(Number.isFinite) || spanSeconds < 4 || processedFrames < 3 || validFrames < 0 || validFrames > processedFrames || uniqueFrames < 0 || uniqueFrames > validFrames || usefulShards < 0 || usefulShardBytes < 0 || storedBytes < 0 || observedSenderFps < 0) return this.currentCode
    if (!this.nextDownProbeAt) this.nextDownProbeAt = now + 30000
    // Completed ZIP bytes are the objective; fresh FEC shards are a leading
    // signal while the next eight-shard block is still being assembled.
    const goodput = (storedBytes + usefulShardBytes * 0.25) / spanSeconds
    if (this.probe) {
      const probe = this.probe
      const midpoint = (opticalPaceFps(this.currentCode) + opticalPaceFps(probe.previousCode)) / 2
      const senderChanged = this.currentCode > probe.previousCode ? observedSenderFps >= midpoint : observedSenderFps > 0 && observedSenderFps <= midpoint
      if (senderChanged && probe.observedAt === null) probe.observedAt = now
      if (probe.observedAt === null && now - probe.requestedAt < 15000) return this.currentCode
      if (probe.observedAt !== null && now - probe.observedAt < 5000) return this.currentCode
      if (probe.observedAt === null) this.currentCode = probe.previousCode // no evidence that the sender received the change
      else if (probe.baselineBytesPerSecond > 0 && (this.currentCode > probe.previousCode ? goodput < probe.baselineBytesPerSecond * 0.75 : goodput <= probe.baselineBytesPerSecond * 1.1)) {
        this.rejectedCode = this.currentCode; this.retryRejectedAt = now + 30000
        this.currentCode = probe.previousCode
      } else if (this.currentCode < probe.previousCode) {
        this.rejectedCode = probe.previousCode; this.retryRejectedAt = now + 30000
      }
      if (probe.previousCode !== this.currentCode) this.nextDownProbeAt = now + 30000
      this.probe = null
      this.lastChangeAt = now
      return this.currentCode
    }
    if (now - this.lastChangeAt < 5000) return this.currentCode
    if (usefulShardBytes === 0 && storedBytes === 0 && processedFrames >= 4 && this.currentCode > 1 && (validFrames < 3 || uniqueFrames < 2 || validFrames / processedFrames < 0.35)) {
      // Do not treat clean, distinct CRC-valid frames at a low display rate
      // as a stall merely because a FEC block has not completed yet.
      this.currentCode -= 1
      this.lastChangeAt = now
    } else if (now >= this.nextDownProbeAt && this.currentCode > 1 && observedSenderFps > 0 && usefulShards / spanSeconds < observedSenderFps * 0.2 && processedFrames - validFrames > validFrames && (this.currentCode - 1 !== this.rejectedCode || now >= this.retryRejectedAt)) {
      // A lossy fast link may still win. Try one slower rate, keep it only if
      // productive bytes per second actually improve by more than 10%.
      this.probe = { previousCode: this.currentCode, baselineBytesPerSecond: goodput, requestedAt: now, observedAt: null }
      this.currentCode -= 1
      this.lastChangeAt = now
      this.nextDownProbeAt = now + 30000
    } else if (validFrames >= 3 && uniqueFrames >= 2 && (usefulShardBytes > 0 || validFrames / processedFrames >= 0.5) && this.currentCode < this.maxCode) {
      // At 1–2 FPS a repeated shard can make useful bytes appear stalled even
      // though the camera is decoding clean frames. Probe a substantially
      // faster rate, then retain it only if sender FPS and goodput confirm it.
      const targetFps = opticalPaceFps(this.currentCode) * 1.8
      const nextCode = Math.min(this.maxCode, Math.max(this.currentCode + 1, AUDIO_PACE_FPS.findIndex(fps => fps >= targetFps)))
      if (nextCode !== this.rejectedCode || now >= this.retryRejectedAt) {
        this.probe = { previousCode: this.currentCode, baselineBytesPerSecond: goodput, requestedAt: now, observedAt: null }
        this.currentCode = nextCode
        this.lastChangeAt = now
      }
    }
    return this.currentCode
  }
}
