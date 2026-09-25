import { DEBUG_PROFILE, decodeOpticalCells, deterministicPayload, encodeOpticalFrame } from './index.ts'
import { CALIBRATION_END_STAGE, calibrationFrameId, calibrationRates, readCalibrationFrameId, selectCalibratedPaceCode } from './calibration.ts'
import { opticalPaceFps, recommendOpticalPaceCode } from './pacing.ts'

const rates = calibrationRates(DEBUG_PROFILE)
if (rates.join(',') !== '2,4,8,15,30') throw new Error('Debug calibration rates changed')
const marker = readCalibrationFrameId(calibrationFrameId(2, 1234))
if (marker?.stage !== 2 || marker.sequence !== 1234 || readCalibrationFrameId(42) !== null) throw new Error('Calibration frame marker changed')
const frameId = calibrationFrameId(2, 1234)
const optical = decodeOpticalCells(encodeOpticalFrame(deterministicPayload(frameId, 64), frameId, 0).cells)
if (!optical.ok || readCalibrationFrameId(optical.header.frameId)?.stage !== 2) throw new Error('Optical calibration frame did not round trip')
if (readCalibrationFrameId(calibrationFrameId(CALIBRATION_END_STAGE, 0))?.stage !== CALIBRATION_END_STAGE) throw new Error('Calibration end marker changed')
const samples = new Map([
  [0, { firstSequence: 0, lastSequence: 5, uniqueFrames: 6, spanMs: 2500 }],
  [1, { firstSequence: 0, lastSequence: 11, uniqueFrames: 10, spanMs: 2600 }],
  [2, { firstSequence: 0, lastSequence: 23, uniqueFrames: 10, spanMs: 2700 }],
  [3, { firstSequence: 0, lastSequence: 44, uniqueFrames: 11, spanMs: 2700 }],
])
if (opticalPaceFps(selectCalibratedPaceCode(DEBUG_PROFILE, samples)) !== 4) throw new Error('Calibration did not select the fastest reliable stage')
if (opticalPaceFps(selectCalibratedPaceCode(DEBUG_PROFILE, new Map())) !== 1) throw new Error('Calibration did not fall back safely')
if (opticalPaceFps(recommendOpticalPaceCode(DEBUG_PROFILE, 3.8, 3.5)) !== 3) throw new Error('Audio pace did not respect measured processed FPS')
console.log(JSON.stringify({ result: 'ok', selectedFps: 4, processedFps: 3.8 }))
