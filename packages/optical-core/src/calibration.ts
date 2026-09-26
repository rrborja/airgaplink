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

export interface CalibrationSample { firstSequence: number; lastSequence: number; uniqueFrames: number; distinctShards: number; spanMs: number }

export function selectCalibratedPaceCode(profile: OpticalProfile, samples: ReadonlyMap<number, CalibrationSample>) {
  const rates = calibrationRates(profile)
  let bestStage = -1, bestThroughput = 0
  for (let stage = 0; stage < rates.length; stage += 1) {
    const sample = samples.get(stage)
    if (!sample || sample.uniqueFrames < 3 || sample.distinctShards < 3 || sample.spanMs < 1000) continue
    // A frame can have a new display ID but repeat an already-seen FEC shard.
    // Reward absolute valid-frame delivery while requiring shard diversity.
    const throughput = sample.uniqueFrames / (sample.spanMs / 1000) * Math.min(1, sample.distinctShards / 8)
    if (throughput >= bestThroughput * 0.95) { bestThroughput = throughput; bestStage = stage }
  }
  if (bestStage < 0) return 1
  for (let code = AUDIO_PACE_FPS.length - 1; code > 0; code -= 1) if (AUDIO_PACE_FPS[code] <= rates[bestStage]) return code
  return 1
}
