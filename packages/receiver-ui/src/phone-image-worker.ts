import { DEBUG_PROFILE, OPTICAL_PROFILES, TemporalOpticalRecovery, crc32, decodeOpticalImage, detectOpticalBoundary, detectOpticalBoundaryNear, type FinderReport, type OpticalBoundary, type OpticalImageDecode } from '../../optical-core/src/index.ts'

/** Canvas/ImageData fallback for mobile browsers without OffscreenCanvas or
 * createImageBitmap. The capture still stays on the phone. */
let boundary: OpticalBoundary | undefined, lastGood: OpticalBoundary | undefined, failures = 0, lastSearch = -Infinity, finderStage = 'searching'
const temporalRecovery = new TemporalOpticalRecovery(crc32)
self.onmessage = (event: MessageEvent<{ image?: ImageData; profileId: string; reset?: boolean }>) => {
  if (event.data.reset) { boundary = undefined; lastGood = undefined; failures = 0; lastSearch = -Infinity; finderStage = 'searching'; temporalRecovery.clear(); return }
  const image = event.data.image
  if (!image) return
  const profile = OPTICAL_PROFILES.find(item => item.id === event.data.profileId) || DEBUG_PROFILE
  const pixels = { data: image.data, width: image.width, height: image.height }
  const now = performance.now()
  if (!boundary && now - lastSearch > 500) {
    lastSearch = now
    const nearby = lastGood && detectOpticalBoundaryNear(pixels, lastGood, profile)
    const report: FinderReport = { stage: 'top-left' }
    boundary = nearby || detectOpticalBoundary(pixels, profile, report) || undefined
    finderStage = nearby ? 'near-reacquired' : report.stage
  }
  let result: OpticalImageDecode = boundary ? decodeOpticalImage(pixels, profile, boundary) : { ok: false, reason: 'finder' }
  if (!result.ok && boundary && failures >= 1) {
    const moved = detectOpticalBoundaryNear(pixels, boundary, profile)
    if (moved) {
      boundary = moved
      finderStage = 'near-reacquired'
      result = decodeOpticalImage(pixels, profile, boundary)
    }
  }
  if (!result.ok && result.reason === 'payload-crc') {
    const recovered = temporalRecovery.add(result, now)
    if (recovered) result = { ...recovered, boundary, symbolConfidence: result.symbolConfidence }
  }
  if (result.ok) { failures = 0; boundary = result.boundary || boundary; lastGood = boundary }
  else if (++failures >= (!lastGood ? 6 : result.reason === 'payload-crc' && (result.symbolConfidence || 0) >= 0.5 ? 30 : 8)) { boundary = undefined; failures = 0; lastSearch = -Infinity }
  self.postMessage({ result: { ...result, candidatePayload: undefined, sampledCells: undefined }, finderStage: boundary ? 'tracked' : finderStage })
}
