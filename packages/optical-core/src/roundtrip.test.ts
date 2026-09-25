import { BINARY_PROFILE, DEBUG_PROFILE, GRAY4_PROFILE, TARGET_PROFILE, decodeOpticalCells, decodeOpticalImage, deterministicPayload, encodeOpticalFrame, framePayloadCapacity, isDeterministicPayload, rasterizeOpticalCells } from './index.ts'

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
  for (let index = 0; index < fourImage.data.length; index += 4) {
    const original = fourImage.data[index]
    const value = Math.max(0, Math.min(255, Math.round(255 * (original / 255) ** 1.4 + ((index * 7) % 5) - 2)))
    fourImage.data[index] = value; fourImage.data[index + 1] = value; fourImage.data[index + 2] = value
  }
  const boundary = { topLeft: { x: 0, y: 0 }, topRight: { x: fourImage.width, y: 0 }, bottomRight: { x: fourImage.width, y: fourImage.height }, bottomLeft: { x: 0, y: fourImage.height }, confidence: 1 }
  const fourDecoded = decodeOpticalImage(fourImage, profile, boundary)
  if (!fourDecoded.ok || !isDeterministicPayload(fourDecoded.payload, 59)) throw new Error(`${profile.id} gamma-shifted image failed: ${fourDecoded.ok ? 'wrong data' : fourDecoded.reason}`)
}
console.log(JSON.stringify({ frameBytes: payload.length, logicalGrid: `${encoded.width}x${encoded.height}`, metadataAgreement: decoded.metadataAgreement, result: 'ok' }))
