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

export interface CalibrationSample { firstSequence: number; lastSequence: number; uniqueFrames: number; distinctShards: number; spanMs: number; recoverableVisits?: number }

/** Calibration uses the same ten-shard visit length as the file stream. A
 * frame from another visit cannot repair an encrypted visit, even if its
 * shard index differs. Count only visits with eight distinct CRC-valid shards. */
export function countRecoverableCalibrationVisits(sequences: ReadonlySet<number>, symbolsPerVisit = 10, sourceShards = 8) {
  if (!Number.isInteger(symbolsPerVisit) || symbolsPerVisit < 1 || symbolsPerVisit > 31 || !Number.isInteger(sourceShards) || sourceShards < 1 || sourceShards > symbolsPerVisit) throw new Error('Invalid calibration FEC layout')
  const visits = new Map<number, number>()
  for (const sequence of sequences) {
    if (!Number.isInteger(sequence) || sequence < 0) continue
    const visit = Math.floor(sequence / symbolsPerVisit)
    visits.set(visit, (visits.get(visit) || 0) | (1 << (sequence % symbolsPerVisit)))
  }
  let recoverable = 0
  for (const mask of visits.values()) {
    let remaining = mask, count = 0
    while (remaining) { remaining &= remaining - 1; count += 1 }
    if (count >= sourceShards) recoverable += 1
  }
  return recoverable
}

export function selectCalibratedPaceCode(profile: OpticalProfile, samples: ReadonlyMap<number, CalibrationSample>) {
  const rates = calibrationRates(profile)
  let bestStage = -1, bestThroughput = 0
  for (let stage = 0; stage < rates.length; stage += 1) {
    const sample = samples.get(stage)
    if (!sample || sample.uniqueFrames < 3 || sample.distinctShards < 3 || sample.spanMs < 1000 || (sample.recoverableVisits !== undefined && (!Number.isInteger(sample.recoverableVisits) || sample.recoverableVisits < 0))) continue
    // Modern receivers report recoverable ten-frame visits. Never select a
    // fast stage merely because it delivered fragments from many incomplete
    // AES-GCM visits. The fallback keeps older callers/test fixtures valid.
    if (sample.recoverableVisits === 0) continue
    const throughput = sample.recoverableVisits === undefined
      ? sample.uniqueFrames / (sample.spanMs / 1000) * Math.min(1, sample.distinctShards / 8)
      : sample.recoverableVisits / (CALIBRATION_STAGE_MS / 1000)
    if (throughput >= bestThroughput * 0.95) { bestThroughput = throughput; bestStage = stage }
  }
  if (bestStage < 0) return 1
  for (let code = AUDIO_PACE_FPS.length - 1; code > 0; code -= 1) if (AUDIO_PACE_FPS[code] <= rates[bestStage]) return code
  return 1
}
