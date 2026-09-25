import { BINARY_PROFILE, DEBUG_PROFILE, GRAY4_PROFILE, RGB4_200_PROFILE, RGB4_PROFILE, RGB_BOOTSTRAP_FRAME_TAG, TARGET_PROFILE, calibrationFrameId, decodeOpticalCells, decodeOpticalImage, deterministicPayload, encodeOpticalFrame, framePayloadCapacity, isDeterministicPayload, opticalProfileNumber, rasterizeOpticalCells, sampleOpticalCells } from './index.ts'

const payload = deterministicPayload(42, framePayloadCapacity(DEBUG_PROFILE))
const encoded = encodeOpticalFrame(payload, 42, 7)
const decoded = decodeOpticalCells(encoded.cells)
if (!decoded.ok) throw new Error(`Codec round trip failed: ${decoded.reason}`)
if (decoded.header.frameId !== 42 || decoded.header.blockId !== 7 || !isDeterministicPayload(decoded.payload, 42)) throw new Error('Codec round trip produced incorrect data')
const imageDecoded = decodeOpticalImage(rasterizeOpticalCells(encoded, 10))
if (!imageDecoded.ok || imageDecoded.header.frameId !== 42) throw new Error(`Image sampling round trip failed: ${imageDecoded.ok ? 'wrong frame' : imageDecoded.reason}`)
// Approximate the camera view: the sender screen fills part of a 1280x720
// image with perspective taper. This exercises finder acquisition before the
// tracked decoder path is used.
const cameraWidth = 1280, cameraHeight = 720
const camera = new Uint8ClampedArray(cameraWidth * cameraHeight * 4)
const [tl, tr, br, bl] = [{ x: 290, y: 120 }, { x: 990, y: 116 }, { x: 960, y: 565 }, { x: 320, y: 569 }]
const dx1 = tr.x - br.x, dx2 = bl.x - br.x, dx3 = tl.x - tr.x + br.x - bl.x
const dy1 = tr.y - br.y, dy2 = bl.y - br.y, dy3 = tl.y - tr.y + br.y - bl.y
const divisor = dx1 * dy2 - dx2 * dy1
const g = (dx3 * dy2 - dx2 * dy3) / divisor, h = (dx1 * dy3 - dx3 * dy1) / divisor
const a = tr.x - tl.x + g * tr.x, b = bl.x - tl.x + h * bl.x, c = tl.x
const d = tr.y - tl.y + g * tr.y, e = bl.y - tl.y + h * bl.y, f = tl.y
for (let y = 0; y < cameraHeight; y += 1) for (let x = 0; x < cameraWidth; x += 1) {
  const p = a - x * g, q = b - x * h, r = d - y * g, s = e - y * h, determinant = p * s - q * r
  const u = ((x - c) * s - q * (y - f)) / determinant, v = (p * (y - f) - (x - c) * r) / determinant
  const inside = u >= 0 && u < 1 && v >= 0 && v < 1
  const cellX = Math.floor(u * encoded.width), cellY = Math.floor(v * encoded.height)
  const value = inside ? encoded.cells[cellY * encoded.width + cellX] ? 232 : 22 : 65
  const offset = (y * cameraWidth + x) * 4
  camera[offset] = value; camera[offset + 1] = value; camera[offset + 2] = value; camera[offset + 3] = 255
}
const cameraDecoded = decodeOpticalImage({ data: camera, width: cameraWidth, height: cameraHeight })
if (!cameraDecoded.ok || cameraDecoded.header.frameId !== 42) throw new Error(`Camera-like image round trip failed: ${cameraDecoded.ok ? 'wrong frame' : cameraDecoded.reason}`)
const softened = new Uint8ClampedArray(camera.length)
for (let y = 0; y < cameraHeight; y += 1) for (let x = 0; x < cameraWidth; x += 1) {
  let total = 0
  for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
    const sourceX = Math.max(0, Math.min(cameraWidth - 1, x + dx)), sourceY = Math.max(0, Math.min(cameraHeight - 1, y + dy))
    total += camera[(sourceY * cameraWidth + sourceX) * 4]
  }
  const offset = (y * cameraWidth + x) * 4, value = Math.min(255, Math.max(0, total / 9 + ((x * 17 + y * 29) % 13) - 6))
  softened[offset] = value; softened[offset + 1] = value; softened[offset + 2] = value; softened[offset + 3] = 255
}
const softenedDecoded = decodeOpticalImage({ data: softened, width: cameraWidth, height: cameraHeight })
if (!softenedDecoded.ok || softenedDecoded.header.frameId !== 42) throw new Error(`Blurred camera-like image failed: ${softenedDecoded.ok ? 'wrong frame' : softenedDecoded.reason}`)
const corrupt = encoded.cells.slice()
for (const [originX, originY] of [[2, 2], [encoded.width - 14, 2], [encoded.width - 14, encoded.height - 14], [2, encoded.height - 14]])
  for (let y = 0; y < 10; y += 1) for (let x = 0; x < 10; x += 1) corrupt[(originY + y) * encoded.width + originX + x] ^= 1
if (decodeOpticalCells(corrupt).ok) throw new Error('Corrupt finder was accepted')
const binaryPayload = deterministicPayload(108, framePayloadCapacity(BINARY_PROFILE))
const binaryFrame = encodeOpticalFrame(binaryPayload, 108, 11, BINARY_PROFILE)
const binaryCells = decodeOpticalCells(binaryFrame.cells, BINARY_PROFILE)
const binaryImage = decodeOpticalImage(rasterizeOpticalCells(binaryFrame, 5), BINARY_PROFILE)
if (!binaryCells.ok || !binaryImage.ok || binaryImage.header.frameId !== 108 || !isDeterministicPayload(binaryImage.payload, 108)) throw new Error('200×120 binary profile failed')
const grayscaleSource = rasterizeOpticalCells(binaryFrame, 5)
const grayscale = new Uint8Array(grayscaleSource.width * grayscaleSource.height)
for (let index = 0; index < grayscale.length; index += 1) grayscale[index] = grayscaleSource.data![index * 4]
const grayDecoded = decodeOpticalImage({ gray: grayscale, grayStride: grayscaleSource.width, width: grayscaleSource.width, height: grayscaleSource.height }, BINARY_PROFILE)
if (!grayDecoded.ok || grayDecoded.header.frameId !== 108) throw new Error('Grayscale plane profile failed')
if (decodeOpticalCells(binaryFrame.cells, DEBUG_PROFILE).ok) throw new Error('Mismatched binary profile was accepted')
for (const profile of [GRAY4_PROFILE, TARGET_PROFILE]) {
  const fourPayload = deterministicPayload(59, framePayloadCapacity(profile))
  const fourFrame = encodeOpticalFrame(fourPayload, 59, 5, profile)
  const fourCells = decodeOpticalCells(fourFrame.cells, profile)
  if (!fourCells.ok || !isDeterministicPayload(fourCells.payload, 59)) throw new Error(`${profile.id} cell round trip failed`)
  const fourImage = rasterizeOpticalCells(fourFrame, profile === TARGET_PROFILE ? 3 : 4)
  const acquiredFourLevel = decodeOpticalImage(fourImage, profile)
  if (!acquiredFourLevel.ok || !isDeterministicPayload(acquiredFourLevel.payload, 59)) throw new Error(`${profile.id} failed four-level finder acquisition: ${acquiredFourLevel.ok ? 'wrong data' : acquiredFourLevel.reason}`)
  const cameraSized = rasterizeOpticalCells(fourFrame, 3)
  const blurredPixels = new Uint8ClampedArray(cameraSized.data!.length)
  for (let y = 0; y < cameraSized.height; y += 1) for (let x = 0; x < cameraSized.width; x += 1) {
    let sum = 0
    for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
      const sourceX = Math.max(0, Math.min(cameraSized.width - 1, x + dx)), sourceY = Math.max(0, Math.min(cameraSized.height - 1, y + dy))
      sum += cameraSized.data![(sourceY * cameraSized.width + sourceX) * 4]
    }
    const offset = (y * cameraSized.width + x) * 4, value = Math.round(sum / 9)
    blurredPixels[offset] = value; blurredPixels[offset + 1] = value; blurredPixels[offset + 2] = value; blurredPixels[offset + 3] = 255
  }
  const acquiredBlurred = decodeOpticalImage({ data: blurredPixels, width: cameraSized.width, height: cameraSized.height }, profile)
  if (!acquiredBlurred.ok || !isDeterministicPayload(acquiredBlurred.payload, 59)) throw new Error(`${profile.id} failed blurred four-level acquisition: ${acquiredBlurred.ok ? 'wrong data' : acquiredBlurred.reason}`)
  for (let index = 0; index < fourImage.data.length; index += 4) {
    const original = fourImage.data[index]
    const value = Math.max(0, Math.min(255, Math.round(255 * (original / 255) ** 1.4 + ((index * 7) % 5) - 2)))
    fourImage.data[index] = value; fourImage.data[index + 1] = value; fourImage.data[index + 2] = value
  }
  const boundary = { topLeft: { x: 0, y: 0 }, topRight: { x: fourImage.width, y: 0 }, bottomRight: { x: fourImage.width, y: fourImage.height }, bottomLeft: { x: 0, y: fourImage.height }, confidence: 1 }
  const fourDecoded = decodeOpticalImage(fourImage, profile, boundary)
  if (!fourDecoded.ok || !isDeterministicPayload(fourDecoded.payload, 59)) throw new Error(`${profile.id} gamma-shifted image failed: ${fourDecoded.ok ? 'wrong data' : fourDecoded.reason}`)
  const shaded = rasterizeOpticalCells(fourFrame, profile === TARGET_PROFILE ? 3 : 4)
  for (let y = 0; y < shaded.height; y += 1) for (let x = 0; x < shaded.width; x += 1) {
    const offset = (y * shaded.width + x) * 4
    const value = Math.round(shaded.data![offset] * 0.5 + 100 * x / shaded.width + 20 * y / shaded.height + (x * 17 + y * 11) % 7 - 3)
    shaded.data![offset] = value; shaded.data![offset + 1] = value; shaded.data![offset + 2] = value
  }
  const locallyShaded = decodeOpticalImage(shaded, profile, boundary)
  if (!locallyShaded.ok || !isDeterministicPayload(locallyShaded.payload, 59)) throw new Error(`${profile.id} locally shaded four-level image failed: ${locallyShaded.ok ? 'wrong data' : locallyShaded.reason}`)
}
if (opticalProfileNumber(RGB4_PROFILE) !== 5 || opticalProfileNumber(RGB4_200_PROFILE) !== 6 || opticalProfileNumber(GRAY4_PROFILE) !== 3) throw new Error('RGB profile changed existing wire profile numbers')
for (const profile of [RGB4_PROFILE, RGB4_200_PROFILE]) for (const size of [79, framePayloadCapacity(profile)]) {
  const rgbPayload = deterministicPayload(73, size)
  const rgbFrame = encodeOpticalFrame(rgbPayload, 73, 6, profile)
  const rgbCells = decodeOpticalCells(rgbFrame.cells, profile)
  if (!rgbCells.ok || !isDeterministicPayload(rgbCells.payload, 73)) throw new Error('RGB cell round trip failed')
  const rgbImage = rasterizeOpticalCells(rgbFrame, 4)
  const boundary = { topLeft: { x: 0, y: 0 }, topRight: { x: rgbImage.width, y: 0 }, bottomRight: { x: rgbImage.width, y: rgbImage.height }, bottomLeft: { x: 0, y: rgbImage.height }, confidence: 1 }
  const rgbDecoded = decodeOpticalImage(rgbImage, profile, boundary)
  if (!rgbDecoded.ok || !isDeterministicPayload(rgbDecoded.payload, 73)) throw new Error(`${profile.id} image round trip failed: ${rgbDecoded.ok ? 'wrong data' : rgbDecoded.reason}`)
  if (size === 79) {
    const acquired = decodeOpticalImage(rgbImage, profile)
    if (!acquired.ok || !isDeterministicPayload(acquired.payload, 73)) throw new Error(`${profile.id} finder acquisition failed: ${acquired.ok ? 'wrong data' : acquired.reason}`)
    const blurred = new Uint8ClampedArray(rgbImage.data!.length)
    for (let y = 0; y < rgbImage.height; y += 1) for (let x = 0; x < rgbImage.width; x += 1) {
      const offset = (y * rgbImage.width + x) * 4
      for (let channel = 0; channel < 3; channel += 1) {
        let sum = 0
        for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
          const sourceX = Math.max(0, Math.min(rgbImage.width - 1, x + dx)), sourceY = Math.max(0, Math.min(rgbImage.height - 1, y + dy))
          sum += rgbImage.data![(sourceY * rgbImage.width + sourceX) * 4 + channel]
        }
        blurred[offset + channel] = Math.round(sum / 9)
      }
      blurred[offset + 3] = 255
    }
    const blurredResult = decodeOpticalImage({ data: blurred, width: rgbImage.width, height: rgbImage.height }, profile, boundary)
    if (!blurredResult.ok || !isDeterministicPayload(blurredResult.payload, 73)) throw new Error(`${profile.id} blurred image failed: ${blurredResult.ok ? 'wrong data' : blurredResult.reason}`)
    // Simulate camera white balance and exposure changes independently in RGB.
    for (let y = 0; y < rgbImage.height; y += 1) for (let x = 0; x < rgbImage.width; x += 1) {
      const offset = (y * rgbImage.width + x) * 4
      for (let channel = 0; channel < 3; channel += 1) rgbImage.data![offset + channel] = Math.min(255, Math.round(rgbImage.data![offset + channel] * [0.7, 0.85, 0.62][channel] + 13 + 20 * x / rgbImage.width))
    }
    const shifted = decodeOpticalImage(rgbImage, profile, boundary)
    if (!shifted.ok || !isDeterministicPayload(shifted.payload, 73)) throw new Error(`${profile.id} white balance/exposure round trip failed: ${shifted.ok ? 'wrong data' : shifted.reason}`)
    const gray = new Uint8Array(rgbImage.width * rgbImage.height)
    for (let index = 0; index < gray.length; index += 1) gray[index] = rgbImage.data![index * 4]
    if (decodeOpticalImage({ gray, width: rgbImage.width, height: rgbImage.height }, profile, boundary).ok) throw new Error('RGB profile accepted a grayscale-only camera path')
  }
}
for (const profile of [RGB4_PROFILE, RGB4_200_PROFILE]) {
  if (framePayloadCapacity(profile) !== (profile === RGB4_200_PROFILE ? 500 : 1125)) throw new Error(`${profile.id} RGB effective capacity changed`)
  const macroWidth = profile.gridWidth / 2, macroTotal = macroWidth * profile.gridHeight / 2
  const corruptMacro = (cells: Uint8Array, frameWidth: number, index: number) => {
    const x = 16 + 2 * (index % macroWidth), y = 16 + 2 * Math.floor(index / macroWidth)
    for (let dy = 0; dy < 2; dy += 1) for (let dx = 0; dx < 2; dx += 1) cells[(y + dy) * frameWidth + x + dx] ^= 3
  }
  const runtimePayload = deterministicPayload(44, 128)
  const runtimeFrame = encodeOpticalFrame(runtimePayload, 44, 6, profile)
  const runtimeSymbols = runtimePayload.length * 4, runtimeTotal = macroTotal
  const runtimeCells = runtimeFrame.cells.slice()
  for (let symbol = 0; symbol < 12; symbol += 1) corruptMacro(runtimeCells, runtimeFrame.width, symbol)
  const recoveredRuntime = decodeOpticalCells(runtimeCells, profile)
  if (!recoveredRuntime.ok || recoveredRuntime.recovery !== 'spatial-copy' || !isDeterministicPayload(recoveredRuntime.payload, 44)) throw new Error(`${profile.id} RGB runtime copy recovery failed`)
  const runtimeMajorityCells = runtimeFrame.cells.slice()
  for (let copy = 0; copy < 3; copy += 1) {
    const index = Math.floor(copy * (runtimeTotal - runtimeSymbols) / 2) + 10 + copy
    corruptMacro(runtimeMajorityCells, runtimeFrame.width, index)
  }
  const recoveredRuntimeMajority = decodeOpticalCells(runtimeMajorityCells, profile)
  if (!recoveredRuntimeMajority.ok || recoveredRuntimeMajority.recovery !== 'majority' || !isDeterministicPayload(recoveredRuntimeMajority.payload, 44)) throw new Error(`${profile.id} RGB runtime majority recovery failed`)
  for (const stage of [0, 127]) {
    const calibration = encodeOpticalFrame(deterministicPayload(124, framePayloadCapacity(profile)), calibrationFrameId(stage, 7), 0, profile)
    const decodedCalibration = decodeOpticalCells(calibration.cells, profile)
    if (!decodedCalibration.ok || !isDeterministicPayload(decodedCalibration.payload, 124)) throw new Error(`${profile.id} confused rate calibration with RGB bootstrap`)
  }
  const offer = deterministicPayload(123, 79)
  const frame = encodeOpticalFrame(offer, RGB_BOOTSTRAP_FRAME_TAG + 7, 0x1234abcd, profile)
  const pristine = decodeOpticalCells(frame.cells, profile)
  if (!pristine.ok || !isDeterministicPayload(pristine.payload, 123) || pristine.header.blockId !== 0x1234abcd) throw new Error(`${profile.id} bootstrap frame failed`)
  for (let index = 0; index < 32; index += 1) {
    const x = 16 + 2 * (index % macroWidth), y = 16 + 2 * Math.floor(index / macroWidth)
    const level = frame.cells[y * frame.width + x]
    if (frame.cells[y * frame.width + x + 1] !== level || frame.cells[(y + 1) * frame.width + x] !== level || frame.cells[(y + 1) * frame.width + x + 1] !== level) throw new Error(`${profile.id} RGB symbol was not a 2×2 same-color macrocell`)
  }
  const image = rasterizeOpticalCells(frame, profile === RGB4_200_PROFILE ? 7 : 5)
  const imageRoundTrip = decodeOpticalImage(image, profile)
  if (!imageRoundTrip.ok || !isDeterministicPayload(imageRoundTrip.payload, 123)) throw new Error(`${profile.id} bootstrap camera round trip failed`)
  const symbols = offer.length * 4, total = macroTotal
  const singleCellNoise = frame.cells.slice()
  for (let copy = 0; copy < 5; copy += 1) {
    const index = Math.floor(copy * (total - symbols) / 4) + 10
    const x = 16 + 2 * (index % macroWidth), y = 16 + 2 * Math.floor(index / macroWidth)
    singleCellNoise[y * frame.width + x] ^= 3
  }
  const recoveredMacro = decodeOpticalCells(singleCellNoise, profile)
  if (!recoveredMacro.ok || !isDeterministicPayload(recoveredMacro.payload, 123)) throw new Error(`${profile.id} failed to correct a camera-cell error in every RGB copy`)
  const corruptSymbol = (cells: Uint8Array, copy: number, relative: number) => {
    const index = Math.floor(copy * (total - symbols) / 4) + relative
    corruptMacro(cells, frame.width, index)
  }
  const oneLostCopy = frame.cells.slice()
  for (let symbol = 0; symbol < 12; symbol += 1) corruptSymbol(oneLostCopy, 0, symbol)
  const recoveredCopy = decodeOpticalCells(oneLostCopy, profile)
  if (!recoveredCopy.ok || recoveredCopy.recovery !== 'spatial-copy') throw new Error(`${profile.id} did not recover a lost bootstrap copy`)
  const dispersedErrors = frame.cells.slice()
  for (let copy = 0; copy < 5; copy += 1) corruptSymbol(dispersedErrors, copy, 10 + copy)
  const majority = decodeOpticalCells(dispersedErrors, profile)
  if (!majority.ok || majority.recovery !== 'majority' || !isDeterministicPayload(majority.payload, 123)) throw new Error(`${profile.id} failed majority recovery of independent copy errors`)
  const allCopiesDamaged = frame.cells.slice()
  for (let copy = 0; copy < 5; copy += 1) corruptSymbol(allCopiesDamaged, copy, 10)
  const rejected = decodeOpticalCells(allCopiesDamaged, profile)
  if (rejected.ok || rejected.reason !== 'payload-crc' || rejected.header?.blockId !== 0x1234abcd) throw new Error(`${profile.id} did not expose a bounded bootstrap CRC failure`)
  const boundary = { topLeft: { x: 1, y: 0 }, topRight: { x: image.width + 1, y: 0 }, bottomRight: { x: image.width + 1, y: image.height }, bottomLeft: { x: 1, y: image.height }, confidence: 1 }
  const phase = sampleOpticalCells(image, boundary, profile, { x: -0.2, y: 0 })
  if (!phase || !decodeOpticalCells(phase.cells, profile).ok) throw new Error(`${profile.id} failed RGB sampling phase correction`)
}
console.log(JSON.stringify({ frameBytes: payload.length, logicalGrid: `${encoded.width}x${encoded.height}`, metadataAgreement: decoded.metadataAgreement, result: 'ok' }))
