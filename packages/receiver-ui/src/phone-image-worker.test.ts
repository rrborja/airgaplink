import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { BINARY_PROFILE, DEBUG_PROFILE, DENSE_BINARY_PROFILE, deterministicPayload, encodeOpticalFrame, opticalProfileNumber, rasterizeOpticalCells, type OpticalImageDecode } from '../../optical-core/src/index.ts'

const results: Array<{ result: OpticalImageDecode; finderStage: string }> = []
const mockWorker = { postMessage: (value: { result: OpticalImageDecode; finderStage: string }) => results.push(value), onmessage: null as null | ((event: MessageEvent) => void) }
Object.assign(globalThis, { self: mockWorker })
await import('./phone-image-worker.ts')
assert.ok(mockWorker.onmessage)

for (const profile of [DEBUG_PROFILE, BINARY_PROFILE, DENSE_BINARY_PROFILE]) {
  mockWorker.onmessage!({ data: { reset: true, profileId: profile.id } } as MessageEvent)
  const payload = deterministicPayload(23, 64)
  const encoded = encodeOpticalFrame(payload, 23, 2, profile)
  const raster = rasterizeOpticalCells(encoded, profile === DENSE_BINARY_PROFILE ? 4 : 6)
  mockWorker.onmessage!({ data: { image: { data: raster.data, width: raster.width, height: raster.height }, profileId: profile.id } } as MessageEvent)
  const last = results.at(-1)
  assert.ok(last)
  if (!last.result.ok) throw new Error(`${profile.id}: ${last.result.reason}`)
  if (last.result.ok) {
    assert.equal(last.result.header.profileId, opticalProfileNumber(profile))
    assert.deepEqual(last.result.payload, payload)
  }
}

// A phone may move several pixels while pointed at the same sender frame.
// Reacquiring nearby finder corners must restore a CRC-valid decode without
// requiring the user to hold the camera absolutely still.
mockWorker.onmessage!({ data: { reset: true, profileId: DEBUG_PROFILE.id } } as MessageEvent)
const movingPayload = deterministicPayload(47, 64)
const movingFrame = encodeOpticalFrame(movingPayload, 47, 3, DEBUG_PROFILE)
const movingRaster = rasterizeOpticalCells(movingFrame, 6)
function shiftedImage(x: number, y: number) {
  const width = movingRaster.width + 72, height = movingRaster.height + 72
  const data = new Uint8ClampedArray(width * height * 4)
  for (let pixel = 0; pixel < width * height; pixel++) {
    data[pixel * 4] = 128
    data[pixel * 4 + 1] = 128
    data[pixel * 4 + 2] = 128
    data[pixel * 4 + 3] = 255
  }
  for (let row = 0; row < movingRaster.height; row++) {
    const source = row * movingRaster.width * 4
    data.set(movingRaster.data!.subarray(source, source + movingRaster.width * 4), ((row + y) * width + x) * 4)
  }
  return { data, width, height }
}
mockWorker.onmessage!({ data: { image: shiftedImage(20, 20), profileId: DEBUG_PROFILE.id } } as MessageEvent)
assert.equal(results.at(-1)?.result.ok, true)
mockWorker.onmessage!({ data: { image: shiftedImage(32, 28), profileId: DEBUG_PROFILE.id } } as MessageEvent)
mockWorker.onmessage!({ data: { image: shiftedImage(32, 28), profileId: DEBUG_PROFILE.id } } as MessageEvent)
const movedResult = results.at(-1)?.result
assert.equal(movedResult?.ok, true, `motion decode: ${movedResult?.ok === false ? movedResult.reason : 'missing result'}`)
if (movedResult?.ok) assert.deepEqual(movedResult.payload, movingPayload)

// Exercise the actual worker entry point using the failed iPhone camera view.
const photo = gunzipSync(readFileSync(new URL('../../optical-core/src/fixtures/iphone-9790.gray.gz', import.meta.url)))
const photoRgba = new Uint8ClampedArray(photo.length * 4)
for (let index = 0; index < photo.length; index++) {
  photoRgba[index * 4] = photoRgba[index * 4 + 1] = photoRgba[index * 4 + 2] = photo[index]
  photoRgba[index * 4 + 3] = 255
}
mockWorker.onmessage!({ data: { reset: true, profileId: DENSE_BINARY_PROFILE.id } } as MessageEvent)
for (let index = 0; index < 3; index++) {
  mockWorker.onmessage!({ data: { image: { data: photoRgba, width: 1224, height: 2176 }, profileId: DENSE_BINARY_PROFILE.id } } as MessageEvent)
  const result = results.at(-1)!.result
  assert.ok(result.ok, `real photo worker: ${result.ok ? '' : result.reason}`)
  assert.equal(result.header.frameId, 391)
  assert.equal(result.header.payloadCrc32, 1439208518)
  assert.ok(result.boundary?.sampling)
}
console.log(JSON.stringify({ result: 'ok', phoneDecodedProfiles: 3, motionReacquisition: true, realCameraPhoto: true }))
