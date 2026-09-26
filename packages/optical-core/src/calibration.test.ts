import { DEBUG_PROFILE, decodeOpticalCells, deterministicPayload, encodeOpticalFrame } from './index.ts'
import { CALIBRATION_END_STAGE, calibrationFrameId, calibrationRates, readCalibrationFrameId, selectCalibratedPaceCode } from './calibration.ts'
import { AdaptiveOpticalPace, opticalPaceFps, recommendOpticalPaceCode } from './pacing.ts'

const rates = calibrationRates(DEBUG_PROFILE)
if (rates.join(',') !== '2,4,8,15,30') throw new Error('Debug calibration rates changed')
const marker = readCalibrationFrameId(calibrationFrameId(2, 1234))
if (marker?.stage !== 2 || marker.sequence !== 1234 || readCalibrationFrameId(42) !== null) throw new Error('Calibration frame marker changed')
const frameId = calibrationFrameId(2, 1234)
const optical = decodeOpticalCells(encodeOpticalFrame(deterministicPayload(frameId, 64), frameId, 0).cells)
if (!optical.ok || readCalibrationFrameId(optical.header.frameId)?.stage !== 2) throw new Error('Optical calibration frame did not round trip')
if (readCalibrationFrameId(calibrationFrameId(CALIBRATION_END_STAGE, 0))?.stage !== CALIBRATION_END_STAGE) throw new Error('Calibration end marker changed')
const samples = new Map([
  [0, { firstSequence: 0, lastSequence: 5, uniqueFrames: 6, distinctShards: 6, spanMs: 2500 }],
  [1, { firstSequence: 0, lastSequence: 11, uniqueFrames: 10, distinctShards: 8, spanMs: 2600 }],
  [2, { firstSequence: 0, lastSequence: 23, uniqueFrames: 10, distinctShards: 7, spanMs: 2700 }],
  [3, { firstSequence: 0, lastSequence: 44, uniqueFrames: 11, distinctShards: 5, spanMs: 2700 }],
])
if (opticalPaceFps(selectCalibratedPaceCode(DEBUG_PROFILE, samples)) !== 4) throw new Error('Calibration did not select the highest useful-throughput stage')
const fastStage = new Map(samples)
fastStage.set(4, { firstSequence: 0, lastSequence: 74, uniqueFrames: 15, distinctShards: 9, spanMs: 2700 })
if (opticalPaceFps(selectCalibratedPaceCode(DEBUG_PROFILE, fastStage)) !== 30) throw new Error('Calibration rejected higher absolute throughput at 30 FPS because of frame loss')
fastStage.set(4, { firstSequence: 0, lastSequence: 74, uniqueFrames: 18, distinctShards: 2, spanMs: 2700 })
if (opticalPaceFps(selectCalibratedPaceCode(DEBUG_PROFILE, fastStage)) !== 4) throw new Error('Calibration mistook repeated FEC shards for useful throughput')
if (opticalPaceFps(selectCalibratedPaceCode(DEBUG_PROFILE, new Map())) !== 1) throw new Error('Calibration did not fall back safely')
if (opticalPaceFps(recommendOpticalPaceCode(DEBUG_PROFILE, 3.8, 3.5)) !== 3) throw new Error('Audio pace did not respect measured processed FPS')
const adaptive = new AdaptiveOpticalPace(DEBUG_PROFILE, 1)
const window = (usefulShardBytes: number, observedSenderFps: number, processedFrames = 12, validFrames = 12, uniqueFrames = 4) => ({ processedFrames, validFrames, uniqueFrames, usefulShards: Math.floor(usefulShardBytes / 1000), usefulShardBytes, storedBytes: 0, observedSenderFps, spanSeconds: 4 })
if (adaptive.update(window(0, 1, 12, 12, 1), 4000) !== 1) throw new Error('Repeated one frame caused a false speed-up')
if (adaptive.update(window(4000, 1), 4000) !== 2 || adaptive.update(window(4000, 1), 8000) !== 2) throw new Error('Productive 1 FPS link did not probe upward or advanced before the sender')
if (adaptive.update(window(8000, 2), 9000) !== 2 || adaptive.update(window(8000, 2), 14000) !== 2) throw new Error('Higher-goodput probe was not accepted')
if (adaptive.update(window(8000, 2), 19000) !== 3 || adaptive.update(window(2000, 3), 24000) !== 3 || adaptive.update(window(2000, 3), 29000) !== 2) throw new Error('Lower-goodput probe did not revert')
if (adaptive.update(window(8000, 2), 34000) !== 2) throw new Error('Rejected faster rate was immediately retried')
if (adaptive.update({ ...window(8000, 2), validFrames: 13 }, 40000) !== 2) throw new Error('Malformed pace statistics changed the recommendation')
const fastWithErrors = new AdaptiveOpticalPace(DEBUG_PROFILE, 13) // 30 FPS
if (fastWithErrors.update(window(16000, 30, 40, 16, 16), 10000) !== 13) throw new Error('High invalid percentage incorrectly lowered a faster productive link')
if (fastWithErrors.update(window(0, 30, 40, 0, 0), 20000) !== 12) throw new Error('Genuine zero-progress stall did not back off')
const testDownProbe = new AdaptiveOpticalPace(DEBUG_PROFILE, 13)
const lossyFast = { ...window(16000, 30, 40, 16, 16), usefulShards: 4 }
if (testDownProbe.update(lossyFast, 10000) !== 13 || testDownProbe.update(lossyFast, 40000) !== 12) throw new Error('Lossy fast link did not wait before testing one slower rate')
if (testDownProbe.update({ ...window(12000, 24, 30, 20, 12), usefulShards: 4 }, 45000) !== 12 || testDownProbe.update({ ...window(12000, 24, 30, 20, 12), usefulShards: 4 }, 50000) !== 13) throw new Error('Slower but less productive rate was not rejected')
console.log(JSON.stringify({ result: 'ok', selectedFps: 4, processedFps: 3.8 }))
