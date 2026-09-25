import type { OpticalProfile } from './index.ts'
import { AUDIO_PACE_FPS } from './pacing.ts'

export const CALIBRATION_STAGE_MS = 3000
export const CALIBRATION_END_STAGE = 127

export function calibrationRates(profile: OpticalProfile) {
  return [2, 4, 8, 15, 30, 60].filter(rate => rate <= profile.targetDisplayFps)
}

export function calibrationFrameId(stage: number, sequence: number) {
  if (!Number.isInteger(stage) || stage < 0 || stage > 127 || !Number.isInteger(sequence) || sequence < 0 || sequence > 0xffffff) throw new Error('Invalid calibration frame ID')
  return (0x80000000 | (stage << 24) | sequence) >>> 0
}

export function readCalibrationFrameId(frameId: number) {
  if ((frameId & 0x80000000) === 0) return null
  return { stage: (frameId >>> 24) & 127, sequence: frameId & 0xffffff }
}

export interface CalibrationSample { firstSequence: number; lastSequence: number; uniqueFrames: number; spanMs: number }

export function selectCalibratedPaceCode(profile: OpticalProfile, samples: ReadonlyMap<number, CalibrationSample>) {
  const rates = calibrationRates(profile)
  for (let stage = rates.length - 1; stage >= 0; stage -= 1) {
    const sample = samples.get(stage)
    if (!sample || sample.uniqueFrames < 3 || sample.spanMs < 1500) continue
    const estimatedFrames = sample.lastSequence - sample.firstSequence + 1
    if (estimatedFrames > 0 && sample.uniqueFrames / estimatedFrames >= 0.65) {
      for (let code = AUDIO_PACE_FPS.length - 1; code > 0; code -= 1) if (AUDIO_PACE_FPS[code] <= rates[stage]) return code
    }
  }
  return 1 // one logical frame per second is the safe fallback
}
