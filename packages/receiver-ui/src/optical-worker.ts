import { DEBUG_PROFILE, OPTICAL_PROFILES, RGB_BOOTSTRAP_FRAME_TAG, decodeOpticalCells, detectOpticalBoundary, frameDimensions, sampleOpticalCells, type FinderReport, type OpticalBoundary, type OpticalImage, type OpticalImageDecode, type Point } from '@qrcopy/optical-core'
import { GpuOpticalSampler } from './gpu-optical-sampler'

// File pixels stay inside this worker and are never supplied to a network API.
let finderCanvas: OffscreenCanvas | undefined
let finderContext: OffscreenCanvasRenderingContext2D | null = null
let cropCanvas: OffscreenCanvas | undefined
let cropContext: OffscreenCanvasRenderingContext2D | null = null
let boundary: OpticalBoundary | undefined // Native camera coordinates.
let failureStreak = 0
let lastAcquisition = 0
let decodedCount = 0
let grayAvailable = typeof VideoFrame !== 'undefined'
let grayBuffer = new Uint8Array(0)
let gpuSampler: GpuOpticalSampler | null = null
let gpuUnavailable = false, gpuVerified = false, gpuAttempts = 0
let gpuDiagnostic = 'not tested'

function translate(point: Point, x: number, y: number): Point { return { x: point.x - x, y: point.y - y } }
function localBoundary(value: OpticalBoundary, x: number, y: number, scale: number): OpticalBoundary {
  const scaled = (point: Point) => { const local = translate(point, x, y); return { x: local.x * scale, y: local.y * scale } }
  return { topLeft: scaled(value.topLeft), topRight: scaled(value.topRight), bottomRight: scaled(value.bottomRight), bottomLeft: scaled(value.bottomLeft), confidence: value.confidence }
}

async function processFrame(data: { bitmap?: ImageBitmap; profileId: string; reset?: boolean; sentAt?: number }) {
  if (data.reset) { boundary = undefined; failureStreak = 0; lastAcquisition = 0; return }
  const bitmap = data.bitmap
  if (!bitmap) return
  const profile = OPTICAL_PROFILES.find(item => item.id === data.profileId) || DEBUG_PROFILE
  const started = performance.now()
  let acquireMs = 0, drawMs = 0, readMs = 0, sampleMs = 0, crcMs = 0
  let finderStage = boundary ? 'tracked' : 'searching'
  if (!boundary && started - lastAcquisition >= 1000) {
    const acquisitionStart = performance.now()
    lastAcquisition = started
    const scale = Math.min(1, 1280 / bitmap.width)
    const width = Math.round(bitmap.width * scale), height = Math.round(bitmap.height * scale)
    if (!finderCanvas || finderCanvas.width !== width || finderCanvas.height !== height) {
      finderCanvas = new OffscreenCanvas(width, height)
      finderContext = finderCanvas.getContext('2d', { willReadFrequently: true })
    }
    if (finderContext) {
      finderContext.drawImage(bitmap, 0, 0, width, height)
      const image = finderContext.getImageData(0, 0, width, height)
      const report: FinderReport = { stage: 'top-left' }
      const found = detectOpticalBoundary({ data: image.data, width, height }, profile, report)
      finderStage = report.stage
      if (found) {
        const expand = (point: Point): Point => ({ x: point.x / scale, y: point.y / scale })
        boundary = { topLeft: expand(found.topLeft), topRight: expand(found.topRight), bottomRight: expand(found.bottomRight), bottomLeft: expand(found.bottomLeft), confidence: found.confidence }
      }
    }
    acquireMs = performance.now() - acquisitionStart
  }
  let result: OpticalImageDecode = { ok: false, reason: 'finder' }
  let usedGpu = false
  let gpuCandidateCells: Uint8Array | undefined
  if (boundary && !gpuUnavailable && (gpuVerified || ++gpuAttempts % 30 === 1)) {
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
        if (decoded.ok || gpuVerified) {
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
      const scale = profile.colorMode === 'rgb' ? 1 : Math.min(1, 5.5 / Math.max(1, pixelsPerCell))
      const scaledWidth = Math.max(1, Math.round(width * scale)), scaledHeight = Math.max(1, Math.round(height * scale))
      if (!cropCanvas || cropCanvas.width !== scaledWidth || cropCanvas.height !== scaledHeight) {
        cropCanvas = new OffscreenCanvas(scaledWidth, scaledHeight)
        cropContext = cropCanvas.getContext('2d', { willReadFrequently: true })
      }
      if (cropContext) {
        let image: OpticalImage | undefined
        if (grayAvailable && scale === 1 && profile.colorMode !== 'rgb') {
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
          const fallback = sampleOpticalCells({ data: pixels.data, width: scaledWidth, height: scaledHeight }, local, profile)
          if (fallback && fallback.symbolConfidence > (sampled?.symbolConfidence || 0) + 0.1) { grayAvailable = false; sampled = fallback }
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
          // During first contact the optical offer is small and repeated in
          // space. Try nearby sub-cell sampling phases before reporting a CRC
          // failure; the metadata/finder samples remain at their original phase.
          if (!decoded.ok && decoded.reason === 'payload-crc' && profile.colorMode === 'rgb' && decoded.header && (decoded.header.frameId >>> 24) === (RGB_BOOTSTRAP_FRAME_TAG >>> 24) && decoded.header.payloadLength <= 512) {
            for (const [dx, dy] of [[-0.2, 0], [0.2, 0], [0, -0.2], [0, 0.2], [-0.2, -0.2], [0.2, -0.2], [-0.2, 0.2], [0.2, 0.2]]) {
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
  bitmap.close()
  if (result.ok) failureStreak = 0
  else {
    failureStreak += 1
    if (usedGpu && failureStreak >= 10) gpuVerified = false
    // A stale quadrilateral can keep sampling the wrong cells even though the
    // frame remains visible. Re-find it promptly without requiring movement.
    if (failureStreak >= 8) { boundary = undefined; failureStreak = 0; lastAcquisition = 0 }
  }
  // The sampled grid is only needed for a UI snapshot; don't copy it every frame.
  const diagnosticsGrid = result.sampledCells && ++decodedCount % 25 === 0 ? result.sampledCells : undefined
  self.postMessage({ result: { ...result, sampledCells: diagnosticsGrid }, finderStage, decodeMs: performance.now() - started, acquireMs, drawMs, readMs, sampleMs, crcMs, pixelPath: usedGpu ? 'GPU symbol grid' : profile.colorMode !== 'rgb' && grayAvailable ? 'Y plane' : 'Canvas RGBA', gpuDiagnostic, sentAt: data.sentAt })
}

self.onmessage = (event: MessageEvent<{ bitmap?: ImageBitmap; profileId: string; reset?: boolean; sentAt?: number }>) => { void processFrame(event.data) }
