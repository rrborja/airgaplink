import { DEBUG_PROFILE, OPTICAL_PROFILES, RGB_BOOTSTRAP_FRAME_TAG, TemporalOpticalRecovery, crc32, decodeOpticalCells, detectOpticalBoundary, detectOpticalBoundaryNear, frameDimensions, recoverBinaryOpticalImage, sampleOpticalCells, type FinderReport, type OpticalBoundary, type OpticalImage, type OpticalImageDecode, type Point } from '@qrcopy/optical-core'
import { GpuOpticalSampler } from './gpu-optical-sampler'

// File pixels stay inside this worker and are never supplied to a network API.
let finderCanvas: OffscreenCanvas | undefined
let finderContext: OffscreenCanvasRenderingContext2D | null = null
let cropCanvas: OffscreenCanvas | undefined
let cropContext: OffscreenCanvasRenderingContext2D | null = null
let boundary: OpticalBoundary | undefined // Native camera coordinates.
let lastGoodBoundary: OpticalBoundary | undefined
let nearBoundaryActive = false
let failureStreak = 0
let lastAcquisition = -Infinity
let phoneFinderMisses = 0
let finderRotation: 0 | 90 | 180 | 270 = 0
let decodedCount = 0
let grayAvailable = typeof VideoFrame !== 'undefined'
let grayBuffer = new Uint8Array(0)
let gpuSampler: GpuOpticalSampler | null = null
let gpuUnavailable = false, gpuVerified = false, gpuAttempts = 0
let gpuDiagnostic = 'not tested'
const temporalRecovery = new TemporalOpticalRecovery(crc32)

function translate(point: Point, x: number, y: number): Point { return { x: point.x - x, y: point.y - y } }
function localBoundary(value: OpticalBoundary, x: number, y: number, scale: number): OpticalBoundary {
  const scaled = (point: Point) => { const local = translate(point, x, y); return { x: local.x * scale, y: local.y * scale } }
  return { ...value, topLeft: scaled(value.topLeft), topRight: scaled(value.topRight), bottomRight: scaled(value.bottomRight), bottomLeft: scaled(value.bottomLeft) }
}

function sourcePoint(point: Point, rotation: 0 | 90 | 180 | 270, width: number, height: number, scale: number): Point {
  if (rotation === 90) return { x: point.y / scale, y: height - point.x / scale }
  if (rotation === 180) return { x: width - point.x / scale, y: height - point.y / scale }
  if (rotation === 270) return { x: width - point.y / scale, y: point.x / scale }
  return { x: point.x / scale, y: point.y / scale }
}
function finderPoint(point: Point, rotation: 0 | 90 | 180 | 270, width: number, height: number, scale: number): Point {
  if (rotation === 90) return { x: (height - point.y) * scale, y: point.x * scale }
  if (rotation === 180) return { x: (width - point.x) * scale, y: (height - point.y) * scale }
  if (rotation === 270) return { x: point.y * scale, y: (width - point.x) * scale }
  return { x: point.x * scale, y: point.y * scale }
}
function mapBoundary(value: OpticalBoundary, map: (point: Point) => Point): OpticalBoundary {
  return { ...value, topLeft: map(value.topLeft), topRight: map(value.topRight), bottomRight: map(value.bottomRight), bottomLeft: map(value.bottomLeft) }
}

function drawFinderImage(bitmap: ImageBitmap, scale: number, rotation: 0 | 90 | 180 | 270) {
  const sourceWidth = Math.round(bitmap.width * scale), sourceHeight = Math.round(bitmap.height * scale)
  const width = rotation === 90 || rotation === 270 ? sourceHeight : sourceWidth
  const height = rotation === 90 || rotation === 270 ? sourceWidth : sourceHeight
  if (!finderCanvas || finderCanvas.width !== width || finderCanvas.height !== height) {
    finderCanvas = new OffscreenCanvas(width, height)
    finderContext = finderCanvas.getContext('2d', { willReadFrequently: true })
  }
  if (!finderContext) return null
  finderContext.setTransform(1, 0, 0, 1, 0, 0)
  finderContext.clearRect(0, 0, width, height)
  if (rotation === 90) { finderContext.translate(width, 0); finderContext.rotate(Math.PI / 2) }
  else if (rotation === 180) { finderContext.translate(width, height); finderContext.rotate(Math.PI) }
  else if (rotation === 270) { finderContext.translate(0, height); finderContext.rotate(-Math.PI / 2) }
  finderContext.drawImage(bitmap, 0, 0, sourceWidth, sourceHeight)
  finderContext.setTransform(1, 0, 0, 1, 0, 0)
  const image = finderContext.getImageData(0, 0, width, height)
  return { data: image.data, width, height }
}

async function processFrame(data: { bitmap?: ImageBitmap; profileId: string; reset?: boolean; sentAt?: number; cameraFrameCount?: number; phoneCapture?: boolean }) {
  if (data.reset) { boundary = undefined; lastGoodBoundary = undefined; nearBoundaryActive = false; failureStreak = 0; lastAcquisition = -Infinity; phoneFinderMisses = 0; finderRotation = 0; temporalRecovery.clear(); return }
  const bitmap = data.bitmap
  if (!bitmap) return
  const sourceWidth = bitmap.width, sourceHeight = bitmap.height
  const profile = OPTICAL_PROFILES.find(item => item.id === data.profileId) || DEBUG_PROFILE
  // A relayed PNG is still a phone-camera frame. Its finder may be small or
  // sensor-rotated, even though this worker does not own a MediaStreamTrack.
  const phoneCapture = !!phoneTrack || !!data.phoneCapture
  const started = performance.now()
  let acquireMs = 0, drawMs = 0, readMs = 0, sampleMs = 0, crcMs = 0
  let finderStage = boundary ? finderRotation ? `tracked-${finderRotation}°` : 'tracked' : 'searching'
  if (!boundary && started - lastAcquisition >= 1000) {
    const acquisitionStart = performance.now()
    lastAcquisition = started
    // A dense grid occupying only part of a phone image can blur the 12-cell
    // finder below its useful size at 1280 px. Alternate the cheap search
    // with a native-resolution retry until a boundary is acquired.
    const finderWidth = phoneCapture && profile.id === 'binary-320x180'
      ? phoneFinderMisses % 3 === 2 ? bitmap.width : phoneFinderMisses % 3 === 1 ? 1920 : 1280
      : 1280
    const scale = Math.min(1, finderWidth / bitmap.width)
    // A camera-track VideoFrame can have a different sensor orientation from
    // the HTML video preview. Search alternate quarter turns only after the
    // upright search fails; the resulting canonical corners are mapped back
    // into the original bitmap for normal CRC-checked sampling.
    const alternateRotations = [0, 90, 270, 180] as const
    const alternate = alternateRotations[Math.max(0, phoneFinderMisses - 2) % alternateRotations.length]
    const rotations: Array<0 | 90 | 180 | 270> = phoneCapture && phoneFinderMisses >= 2 && alternate !== finderRotation
      ? [finderRotation, alternate] : [finderRotation]
    for (const rotation of rotations) {
      const pixels = drawFinderImage(bitmap, scale, rotation)
      if (!pixels) continue
      const previous = rotation === 0 && lastGoodBoundary && localBoundary(lastGoodBoundary, 0, 0, scale)
      const nearby = previous && detectOpticalBoundaryNear(pixels, previous, profile)
      const report: FinderReport = { stage: 'top-left' }
      const found = nearby || detectOpticalBoundary(pixels, profile, report)
      finderStage = nearby ? 'near-reacquired' : found && rotation ? `tracked-${rotation}°` : report.stage
      if (!found) continue
      finderRotation = rotation
      phoneFinderMisses = 0
      nearBoundaryActive = !!nearby
      const expand = (point: Point) => sourcePoint(point, rotation, bitmap.width, bitmap.height, scale)
      boundary = mapBoundary(found, expand)
      break
    }
    if (!boundary && phoneCapture) phoneFinderMisses += 1
    acquireMs = performance.now() - acquisitionStart
  }
  // Follow nearby finder motion before sampling this frame. A single bad read
  // is enough to trigger a local search on the next capture, including when
  // the previous corners still have high contrast but no longer line up.
  if (boundary && failureStreak >= 1) {
    const motionStart = performance.now(), scale = Math.min(1, 1280 / bitmap.width)
    const pixels = drawFinderImage(bitmap, scale, finderRotation)
    if (pixels) {
      const predicted = mapBoundary(boundary, point => finderPoint(point, finderRotation, bitmap.width, bitmap.height, scale))
      const found = detectOpticalBoundaryNear(pixels, predicted, profile)
      if (found) {
        boundary = mapBoundary(found, point => sourcePoint(point, finderRotation, bitmap.width, bitmap.height, scale))
        nearBoundaryActive = true
        finderStage = 'near-reacquired'
      }
    }
    acquireMs += performance.now() - motionStart
  }
  let result: OpticalImageDecode = { ok: false, reason: 'finder' }
  let usedGpu = false
  let gpuCandidateCells: Uint8Array | undefined
  // The GPU homography does not yet implement calibrated lens correction.
  if (boundary && profile.id !== 'binary-320x180' && !boundary.sampling && !gpuUnavailable && (gpuVerified || ++gpuAttempts % 30 === 1)) {
    try {
      gpuSampler ||= new GpuOpticalSampler()
      const gpuStart = performance.now()
      const image = gpuSampler.sample(bitmap, boundary, profile)
      readMs = performance.now() - gpuStart
      const dimensions = frameDimensions(profile)
      const logicalBoundary: OpticalBoundary = { topLeft: { x: -0.5, y: -0.5 }, topRight: { x: dimensions.width - 0.5, y: -0.5 }, bottomRight: { x: dimensions.width - 0.5, y: dimensions.height - 0.5 }, bottomLeft: { x: -0.5, y: dimensions.height - 0.5 }, confidence: 1 }
      const sampleStart = performance.now()
      const sampled = sampleOpticalCells(image, logicalBoundary, profile)
      sampleMs = performance.now() - sampleStart
      if (sampled) {
        gpuCandidateCells = sampled.cells
        const crcStart = performance.now()
        const decoded = decodeOpticalCells(sampled.cells, profile)
        crcMs = performance.now() - crcStart
        gpuDiagnostic = `${decoded.ok ? 'valid' : decoded.reason} · ${(sampled.symbolConfidence * 100).toFixed(0)}%`
        if (decoded.ok) {
          gpuVerified = true; usedGpu = true
          result = { ...decoded, boundary, sampledCells: sampled.cells, symbolConfidence: sampled.symbolConfidence }
        }
      }
    } catch (error) { gpuUnavailable = true; gpuVerified = false; gpuDiagnostic = error instanceof Error ? error.message : 'GPU unavailable' }
  }
  if (boundary && !usedGpu) {
    const corners = [boundary.topLeft, boundary.topRight, boundary.bottomRight, boundary.bottomLeft]
    const x = Math.max(0, Math.floor(Math.min(...corners.map(point => point.x)) - 16))
    const y = Math.max(0, Math.floor(Math.min(...corners.map(point => point.y)) - 16))
    const right = Math.min(bitmap.width, Math.ceil(Math.max(...corners.map(point => point.x)) + 16))
    const bottom = Math.min(bitmap.height, Math.ceil(Math.max(...corners.map(point => point.y)) + 16))
    const width = right - x, height = bottom - y
    if (width > 0 && height > 0) {
      const pixelsPerCell = Math.min(Math.hypot(boundary.topRight.x - boundary.topLeft.x, boundary.topRight.y - boundary.topLeft.y) / (profile.gridWidth + 32), Math.hypot(boundary.bottomLeft.x - boundary.topLeft.x, boundary.bottomLeft.y - boundary.topLeft.y) / (profile.gridHeight + 32))
      // RGB needs the camera's native color samples. Canvas downscaling blends
      // adjacent display primaries before the macrocell center is classified.
      // Keep dense phone frames at native resolution. Resampling their
      // roughly six-pixel-wide cells blurs the very edges used for CRC-valid
      // binary classification; only the lower-density profiles use the
      // reduced readback path.
      const scale = profile.colorMode === 'rgb' || profile.id === 'binary-320x180' ? 1 : Math.min(1, 5.5 / Math.max(1, pixelsPerCell))
      const scaledWidth = Math.max(1, Math.round(width * scale)), scaledHeight = Math.max(1, Math.round(height * scale))
      if (!cropCanvas || cropCanvas.width !== scaledWidth || cropCanvas.height !== scaledHeight) {
        cropCanvas = new OffscreenCanvas(scaledWidth, scaledHeight)
        cropContext = cropCanvas.getContext('2d', { willReadFrequently: true })
      }
      if (cropContext) {
        let image: OpticalImage | undefined
        // Dense binary grids need the exact camera pixels. A WebKit I420 plane
        // can look high-contrast while its crop/orientation differs from the
        // canvas preview; confidence alone cannot detect that mismatch.
        if (grayAvailable && scale === 1 && profile.colorMode !== 'rgb' && profile.id !== 'binary-320x180') {
          const readStart = performance.now()
          try {
            const frame = new VideoFrame(bitmap, { timestamp: 0 })
            try {
              const rect = { x, y, width, height }
              const size = frame.allocationSize({ rect, format: 'I420' })
              if (grayBuffer.length < size) grayBuffer = new Uint8Array(size)
              const planes = await frame.copyTo(grayBuffer, { rect, format: 'I420' })
              image = { gray: grayBuffer.subarray(planes[0].offset), grayStride: planes[0].stride, width: scaledWidth, height: scaledHeight }
            } finally { frame.close() }
          } catch { grayAvailable = false }
          readMs = performance.now() - readStart
        }
        if (!image) {
          const drawStart = performance.now()
          cropContext.drawImage(bitmap, x, y, width, height, 0, 0, scaledWidth, scaledHeight)
          drawMs = performance.now() - drawStart
          const readStart = performance.now()
          const pixels = cropContext.getImageData(0, 0, scaledWidth, scaledHeight)
          readMs = performance.now() - readStart
          image = { data: pixels.data, width: scaledWidth, height: scaledHeight }
        }
        const local = localBoundary(boundary, x, y, scale)
        const sampleStart = performance.now()
        let sampled = sampleOpticalCells(image, local, profile)
        // Some WebKit versions accept I420 copyTo yet return a malformed Y
        // plane. Compare a low-confidence read against the established path.
        if (image.gray && (!sampled || sampled.symbolConfidence < 0.2)) {
          const fallbackStart = performance.now()
          cropContext.drawImage(bitmap, x, y, width, height, 0, 0, scaledWidth, scaledHeight)
          drawMs += performance.now() - fallbackStart
          const fallbackRead = performance.now()
          const pixels = cropContext.getImageData(0, 0, scaledWidth, scaledHeight)
          readMs += performance.now() - fallbackRead
          const fallbackImage = { data: pixels.data, width: scaledWidth, height: scaledHeight }
          const fallback = sampleOpticalCells(fallbackImage, local, profile)
          if (fallback && fallback.symbolConfidence > (sampled?.symbolConfidence || 0) + 0.1) { grayAvailable = false; sampled = fallback; image = fallbackImage }
        }
        sampleMs = performance.now() - sampleStart
        if (sampled) {
          if (gpuCandidateCells && gpuCandidateCells.length === sampled.cells.length) {
            let different = 0
            for (let index = 0; index < sampled.cells.length; index += 1) if (gpuCandidateCells[index] !== sampled.cells[index]) different += 1
            gpuDiagnostic += ` · Δ${(100 * different / sampled.cells.length).toFixed(0)}%`
          }
          const crcStart = performance.now()
          let decoded = decodeOpticalCells(sampled.cells, profile)
          if (!decoded.ok && 'binaryThreshold' in sampled && sampled.binaryThreshold !== undefined) {
            const recovered = recoverBinaryOpticalImage(image, local, profile, decoded, sampled.binaryThreshold)
            if (recovered?.ok) {
              decoded = recovered
              boundary = { ...boundary, sampling: recovered.boundary?.sampling }
            }
          }
          // A clear dense grid can still land one camera pixel off the cell
          // centers after finder homography. For small repeated handshake
          // frames, test bounded sub-cell phases and accept only CRC-valid data.
          const retryPhase = decoded.header && decoded.header.payloadLength <= 512 && profile.colorMode === 'rgb' && (decoded.header.frameId >>> 24) === (RGB_BOOTSTRAP_FRAME_TAG >>> 24)
          if (!decoded.ok && decoded.reason === 'payload-crc' && retryPhase) {
            for (const [dx, dy] of [[-0.25, 0], [0.25, 0], [0, -0.25], [0, 0.25], [-0.25, -0.25], [0.25, -0.25], [-0.25, 0.25], [0.25, 0.25]]) {
              const retry = sampleOpticalCells(image, local, profile, { x: dx, y: dy })
              if (!retry) continue
              const candidate = decodeOpticalCells(retry.cells, profile)
              if (candidate.ok) { sampled = retry; decoded = { ...candidate, recovery: 'phase' }; break }
            }
          }
          result = { ...decoded, boundary, sampledCells: sampled.cells, symbolConfidence: sampled.symbolConfidence }
          crcMs = performance.now() - crcStart
        }
      }
    }
  }
  if (!result.ok && result.reason === 'payload-crc') {
    const recovered = temporalRecovery.add(result, performance.now())
    if (recovered) result = { ...recovered, boundary, sampledCells: result.sampledCells, symbolConfidence: result.symbolConfidence }
  }
  bitmap.close()
  if (result.ok) { failureStreak = 0; lastGoodBoundary = boundary; nearBoundaryActive = false }
  else {
    failureStreak += 1
    const trustedGeometry = result.reason === 'payload-crc' && !!result.header && (result.symbolConfidence || 0) >= 0.5
    if (usedGpu && failureStreak >= 10 && !trustedGeometry) gpuVerified = false
    // A stale quadrilateral can keep sampling the wrong cells even though the
    // frame remains visible. Valid metadata and strong contrast instead get
    // time to accumulate repeated payloads before a more costly re-find.
    if (failureStreak >= (!lastGoodBoundary ? 6 : trustedGeometry ? 30 : 8)) { if (nearBoundaryActive) lastGoodBoundary = undefined; nearBoundaryActive = false; boundary = undefined; failureStreak = 0; lastAcquisition = -Infinity }
  }
  // The sampled grid is only needed for a UI snapshot; don't copy it every frame.
  const diagnosticsGrid = result.sampledCells && ++decodedCount % 25 === 0 ? result.sampledCells : undefined
  self.postMessage({ result: { ...result, candidatePayload: undefined, sampledCells: diagnosticsGrid }, finderStage, decodeMs: performance.now() - started, acquireMs, drawMs, readMs, sampleMs, crcMs, pixelPath: usedGpu ? 'GPU symbol grid' : profile.colorMode !== 'rgb' && grayAvailable && profile.id !== 'binary-320x180' ? 'Y plane' : 'Canvas RGBA', gpuDiagnostic, temporalRecoveries: temporalRecovery.recovered, temporalCandidates: temporalRecovery.lastCandidateCount, sentAt: data.sentAt, cameraFrameCount: data.cameraFrameCount, sourceWidth, sourceHeight })
}

let phoneTrack: MediaStreamTrack | null = null, trackGeneration = 0, phoneTrackProfileId: string = DEBUG_PROFILE.id
async function processPhoneTrack(track: MediaStreamTrack, profileId: string) {
  const generation = ++trackGeneration
  phoneTrack = track
  phoneTrackProfileId = profileId
  try {
    // This API is not available in every mobile browser. Unlike video-frame
    // callbacks, it is not capped by the phone display's paint refresh rate.
    const Processor = (globalThis as typeof globalThis & { MediaStreamTrackProcessor?: new (options: { track: MediaStreamTrack }) => { readable: ReadableStream<VideoFrame> } }).MediaStreamTrackProcessor
    if (!Processor) throw new Error('Camera track processor unavailable')
    const reader = new Processor({ track }).readable.getReader()
    self.postMessage({ capturePath: 'track-ready' })
    let count = 0
    try {
      while (generation === trackGeneration) {
        const { value: frame, done } = await reader.read()
        if (done || !frame) break
        try {
          const bitmap = await createImageBitmap(frame)
          if (generation === trackGeneration) await processFrame({ bitmap, profileId: phoneTrackProfileId, cameraFrameCount: ++count })
          else bitmap.close()
        } finally { frame.close() }
      }
    } finally { void reader.cancel().catch(() => {}); reader.releaseLock() }
  } catch {
    if (generation === trackGeneration) self.postMessage({ capturePath: 'track-unavailable' })
  } finally {
    track.stop()
    if (phoneTrack === track) phoneTrack = null
  }
}

self.onmessage = (event: MessageEvent<{ bitmap?: ImageBitmap; profileId: string; reset?: boolean; sentAt?: number; phoneTrack?: MediaStreamTrack; stopPhoneTrack?: boolean; phoneCapture?: boolean }>) => {
  if (event.data.stopPhoneTrack) { trackGeneration += 1; phoneTrack?.stop(); phoneTrack = null; return }
  if (event.data.phoneTrack) { void processPhoneTrack(event.data.phoneTrack, event.data.profileId); return }
  if (event.data.reset) phoneTrackProfileId = event.data.profileId
  void processFrame(event.data).catch(error => {
    try { event.data.bitmap?.close() } catch { /* The frame may already be closed. */ }
    // Always release the main thread's busy gate so one failed decode cannot
    // permanently stop camera capture and optical progress.
    self.postMessage({ result: { ok: false, reason: 'finder' }, finderStage: 'worker-error', decodeMs: 0, acquireMs: 0, drawMs: 0, readMs: 0, sampleMs: 0, crcMs: 0, pixelPath: 'unavailable', gpuDiagnostic: error instanceof Error ? error.message : 'Worker decode failed', sentAt: event.data.sentAt })
  })
}
