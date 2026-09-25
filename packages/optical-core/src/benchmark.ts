import { OPTICAL_PROFILES, decodeOpticalCells, decodeOpticalImage, deterministicPayload, encodeOpticalFrame, framePayloadCapacity, rasterizeOpticalCells } from './index.ts'

const results = []
for (const profile of OPTICAL_PROFILES) {
  const iterations = profile.bitsPerSymbol === 2 ? 12 : 30
  const payloadBytes = framePayloadCapacity(profile)
  let started = performance.now()
  for (let index = 0; index < iterations; index += 1) encodeOpticalFrame(deterministicPayload(index, payloadBytes), index, 0, profile)
  const encodeMs = (performance.now() - started) / iterations
  const frame = encodeOpticalFrame(deterministicPayload(9, payloadBytes), 9, 0, profile)
  started = performance.now()
  for (let index = 0; index < iterations; index += 1) {
    const decoded = decodeOpticalCells(frame.cells, profile)
    if (!decoded.ok) throw new Error(`${profile.id} cell decode failed`)
  }
  const cellDecodeMs = (performance.now() - started) / iterations
  const pixels = profile.gridWidth >= 400 ? 3 : profile.gridWidth >= 300 ? 4 : profile.gridWidth >= 200 ? 5 : 8
  const image = rasterizeOpticalCells(frame, pixels)
  const boundary = { topLeft: { x: 0, y: 0 }, topRight: { x: image.width, y: 0 }, bottomRight: { x: image.width, y: image.height }, bottomLeft: { x: 0, y: image.height }, confidence: 1 }
  started = performance.now()
  for (let index = 0; index < iterations; index += 1) {
    const decoded = decodeOpticalImage(image, profile, boundary)
    if (!decoded.ok) throw new Error(`${profile.id} tracked image decode failed: ${decoded.reason}`)
  }
  const trackedDecodeMs = (performance.now() - started) / iterations
  results.push({ profile: profile.id, payloadBytesPerFrame: payloadBytes, theoreticalPayloadMBpsAt60Fps: Number((payloadBytes * 60 / 1e6).toFixed(3)), encodeMs: Number(encodeMs.toFixed(2)), cellDecodeMs: Number(cellDecodeMs.toFixed(2)), trackedSyntheticDecodeMs: Number(trackedDecodeMs.toFixed(2)), syntheticDecodeFps: Number((1000 / trackedDecodeMs).toFixed(1)), syntheticCpuLimitedMBps: Number((payloadBytes * 1000 / trackedDecodeMs / 1e6).toFixed(3)) })
}
console.log(JSON.stringify({ kind: 'synthetic-optical-benchmark', note: 'Node synthetic raster and known geometry; excludes camera, finder acquisition, display refresh, torn frames, and FEC. Not physical throughput.', results }, null, 2))
