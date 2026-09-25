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
