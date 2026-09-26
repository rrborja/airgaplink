import { CameraFrameMeter, applyShortExposure, cameraSettingsSummary, restoreAutoExposure } from './camera-telemetry.ts'

const meter = new CameraFrameMeter()
meter.add(0, 1)
if (Math.abs(meter.add(1000, 31) - 30) > 0.01) throw new Error('Camera delivered-FPS meter missed presented frames')
if (Math.abs(meter.add(2000, 61) - 30) > 0.01 || Math.abs(meter.add(2500, 61) - 30) > 0.01) throw new Error('Duplicate camera callback changed delivered FPS')
let applied: MediaTrackConstraints | null = null
const track = {
  getCapabilities: () => ({ exposureMode: ['continuous', 'manual'], exposureTime: { min: 10, max: 1000 } }),
  getSettings: () => applied ? { width: 1920, height: 1080, frameRate: 60, exposureMode: (applied as { advanced: Array<{ exposureMode: string; exposureTime?: number }> }).advanced[0].exposureMode, exposureTime: 83 } : { width: 1920, height: 1080, frameRate: 60, exposureMode: 'continuous' },
  applyConstraints: async (constraints: MediaTrackConstraints) => { applied = constraints },
} as unknown as MediaStreamTrack
if (!cameraSettingsSummary(track).canShortenExposure || !await applyShortExposure(track) || !await restoreAutoExposure(track)) throw new Error('Supported short-exposure control failed')
const unsupported = { getCapabilities: () => ({}), getSettings: () => ({}), applyConstraints: async () => { throw new Error('Unsupported camera control was applied') } } as unknown as MediaStreamTrack
if (cameraSettingsSummary(unsupported).canShortenExposure || await applyShortExposure(unsupported) || await restoreAutoExposure(unsupported)) throw new Error('Unsupported exposure control was used')
console.log(JSON.stringify({ result: 'ok', deliveredFps: meter.fps }))
