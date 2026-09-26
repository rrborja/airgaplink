/** Keep device IDs and labels out of diagnostics; report only capture behavior. */
interface ExposureCapabilities extends MediaTrackCapabilities {
  exposureMode?: string[]
  exposureTime?: { min: number; max: number; step?: number }
}
interface ExposureSettings extends MediaTrackSettings {
  exposureMode?: string
  exposureTime?: number
  focusMode?: string
}

export interface CameraSettingsSummary {
  width: number
  height: number
  configuredFps: number
  exposureMode: string
  exposureTime: number | null
  focusMode: string
  canShortenExposure: boolean
  canRestoreAuto: boolean
}

export function cameraSettingsSummary(track: MediaStreamTrack): CameraSettingsSummary {
  const settings = track.getSettings() as ExposureSettings
  let capabilities: ExposureCapabilities = {}
  try { if (typeof track.getCapabilities === 'function') capabilities = track.getCapabilities() as ExposureCapabilities }
  catch { /* Camera settings are still usable without optional controls. */ }
  const exposure = capabilities.exposureTime
  return {
    width: settings.width || 0,
    height: settings.height || 0,
    configuredFps: settings.frameRate || 0,
    exposureMode: settings.exposureMode || 'unreported',
    exposureTime: Number.isFinite(settings.exposureTime) ? settings.exposureTime! : null,
    focusMode: settings.focusMode || 'unreported',
    canShortenExposure: !!capabilities.exposureMode?.includes('manual') && !!capabilities.exposureMode?.includes('continuous') && !!exposure && Number.isFinite(exposure.min) && Number.isFinite(exposure.max) && exposure.min <= 83 && exposure.max >= 83,
    canRestoreAuto: !!capabilities.exposureMode?.includes('continuous'),
  }
}

/** Image Capture specifies exposureTime in 100 µs units: 83 ≈ 1/120 s.
 * This is opt-in because a short shutter can make a dim camera image unreadable. */
export async function applyShortExposure(track: MediaStreamTrack) {
  if (!cameraSettingsSummary(track).canShortenExposure) return false
  await track.applyConstraints({ advanced: [{ exposureMode: 'manual', exposureTime: 83 }] } as unknown as MediaTrackConstraints)
  const settings = track.getSettings() as ExposureSettings
  return settings.exposureMode === 'manual' && settings.exposureTime !== undefined && settings.exposureTime <= 125
}

export async function restoreAutoExposure(track: MediaStreamTrack) {
  if (!cameraSettingsSummary(track).canRestoreAuto) return false
  await track.applyConstraints({ advanced: [{ exposureMode: 'continuous' }] } as unknown as MediaTrackConstraints)
  return (track.getSettings() as ExposureSettings).exposureMode === 'continuous'
}

/** presentedFrames counts source frames even when a busy decoder skips them. */
export class CameraFrameMeter {
  private samples: Array<{ at: number; count: number }> = []

  add(at: number, presentedFrames: number) {
    if (!Number.isFinite(at) || !Number.isInteger(presentedFrames) || presentedFrames < 0 || (this.samples.length && presentedFrames <= this.samples[this.samples.length - 1].count)) return this.fps
    this.samples.push({ at, count: presentedFrames })
    while (this.samples.length > 1 && at - this.samples[0].at > 5000) this.samples.shift()
    return this.fps
  }

  get fps() {
    if (this.samples.length < 2) return 0
    const first = this.samples[0], last = this.samples[this.samples.length - 1]
    return last.at > first.at ? 1000 * (last.count - first.count) / (last.at - first.at) : 0
  }
}
