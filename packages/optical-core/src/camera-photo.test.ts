import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { DENSE_BINARY_PROFILE, crc32, decodeHandshakeOffer, decodeOpticalCells, decodeOpticalImage, detectOpticalBoundaryNear, recoverBinaryOpticalImage, sampleOpticalCells, type OpticalImage } from './index.ts'

const source = gunzipSync(readFileSync(new URL('./fixtures/iphone-9790.gray.gz', import.meta.url)))
const width = 1224, height = 2176
assert.equal(source.length, width * height)
const timings = []
for (const turn of [0, 1, 2, 3]) {
  const w = turn % 2 ? height : width, h = turn % 2 ? width : height
  const gray = new Uint8Array(w * h)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const nx = turn === 1 ? height - 1 - y : turn === 2 ? width - 1 - x : turn === 3 ? y : x
    const ny = turn === 1 ? x : turn === 2 ? height - 1 - y : turn === 3 ? width - 1 - x : y
    gray[ny * w + nx] = source[y * width + x]
  }
  const image: OpticalImage = { gray, width: w, height: h }
  const start = performance.now()
  const result = decodeOpticalImage(image, DENSE_BINARY_PROFILE)
  const acquireMs = performance.now() - start
  assert.ok(result.ok, `${turn * 90}°: ${result.ok ? '' : result.reason}`)
  assert.equal(result.header.frameId, 391)
  assert.equal(result.header.payloadLength, 73)
  assert.equal(crc32(result.payload), 1439208518)
  assert.ok(decodeHandshakeOffer(result.payload))
  assert.ok(result.boundary?.sampling, 'Cache the successful camera correction')
  const trackedStart = performance.now()
  for (let index = 0; index < 20; index++) {
    const tracked = decodeOpticalImage(image, DENSE_BINARY_PROFILE, result.boundary)
    assert.ok(tracked.ok)
    assert.deepEqual(tracked.payload, result.payload)
  }
  const trackedMs = (performance.now() - trackedStart) / 20
  const nearby = detectOpticalBoundaryNear(image, result.boundary, DENSE_BINARY_PROFILE)
  assert.deepEqual(nearby?.sampling, result.boundary.sampling)
  const sampled = sampleOpticalCells(image, result.boundary, DENSE_BINARY_PROFILE)!
  assert.ok(decodeOpticalCells(sampled.cells, DENSE_BINARY_PROFILE).ok, 'Cached calibration decodes without another search')
  assert.ok('binaryThreshold' in sampled && sampled.binaryThreshold !== undefined)
  const corrupted = recoverBinaryOpticalImage(image, result.boundary, DENSE_BINARY_PROFILE, {
    ok: false, reason: 'payload-crc', header: { ...result.header, payloadCrc32: result.header.payloadCrc32 ^ 1 },
  }, sampled.binaryThreshold)
  assert.equal(corrupted, null, 'Calibration must never bypass payload CRC')
  timings.push({ rotation: turn * 90, acquireMs: Math.round(acquireMs), trackedMs: +trackedMs.toFixed(2) })
}
console.log(JSON.stringify({ result: 'ok', realCameraPhoto: timings }))

// Second user camera capture after the phone had automatically zoomed to
// 1.6×. All four corners were still in view. Its real offer must decode too.
const zoomed = gunzipSync(readFileSync(new URL('./fixtures/iphone-9791.gray.gz', import.meta.url)))
assert.equal(zoomed.length, 1230 * 2190)
const zoomedImage: OpticalImage = { gray: zoomed, width: 1230, height: 2190 }
const zoomedResult = decodeOpticalImage(zoomedImage, DENSE_BINARY_PROFILE)
assert.ok(zoomedResult.ok, `zoomed photo: ${zoomedResult.ok ? '' : zoomedResult.reason}`)
assert.equal(zoomedResult.header.frameId, 3910)
assert.equal(zoomedResult.header.payloadCrc32, 1439208518)
assert.ok(decodeHandshakeOffer(zoomedResult.payload))
assert.ok(zoomedResult.boundary?.sampling)
