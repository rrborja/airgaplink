/**
 * Pure codec for the local screen-to-camera transport. It deliberately has no
 * networking imports: optical payloads are represented only as typed arrays.
 */
export const TransportMode = {
  QR: 'QR',
  OPTICAL_HIGH_SPEED: 'OPTICAL_HIGH_SPEED',
} as const
export type TransportMode = typeof TransportMode[keyof typeof TransportMode]
export { OpticalBlockCollector, ReedSolomonBlockCodec, packOpticalSymbol, unpackOpticalSymbol, packTransferManifest, unpackTransferManifest, SYMBOL_HEADER_BYTES, TRANSFER_MANIFEST_BYTES } from './fec.ts'
export type { EncodedBlock, OpticalSymbol, AvailableSymbol, ErasureEngine, TransferManifest } from './fec.ts'
export { ControlType, CONTROL_MAX_PAYLOAD, FSK_SYMBOL_SECONDS, FSK_ZERO_HZ, FSK_ONE_HZ, QUAD_FSK_TONES_HZ, QUAD_FSK_SYNC_HZ, packControlPacket, unpackControlPacket, packCompactControlPacket, unpackCompactControlPacket, makeBlockStatusPayload, readBlockStatusPayload, makeCompactStatusPayload, readCompactStatusPayload, encodeFskPacket, encodeCompactFskPacket, encodeQuadFskPacket, encodeQuadCompactFskPacket, encodeQuadFskHandshakePacket, decodeFskSamples, decodeQuadFskSamples, decodeQuadFskHandshakeSamples } from './control.ts'
export { OCTAL_FSK_TONES_HZ, OCTAL_FSK_SYNC_HZ, encodeOctalFskPacket, encodeOctalCompactFskPacket, encodeOctalFskHandshakePacket, decodeOctalFskSamples } from './octal-fsk.ts'
export { responseToneCount, runtimeToneAllowed, runtimeToneCount, compactReadyNegotiated } from './audio-mode.ts'
export type { ControlPacket } from './control.ts'
export { CRYPTO_PROTOCOL_VERSION, SESSION_ID_BYTES, NONCE_BYTES, X25519_KEY_BYTES, generateEphemeralKeyPair, x25519SharedSecret, deriveSessionKeys, generateIdentityKeyPair, signIdentity, verifyIdentity, opticalNonce, opticalBlockAad, aesGcmEncrypt, aesGcmDecrypt, OpticalBlockEncryptor, zeroBytes } from './crypto.ts'
export type { EphemeralKeyPair, SessionKeys } from './crypto.ts'
export { HANDSHAKE_CAPABILITY_IDENTITY, HANDSHAKE_CAPABILITY_QUAD_FSK, HANDSHAKE_CAPABILITY_QUAD_CONTROL, HANDSHAKE_CAPABILITY_OCTAL_FSK, HANDSHAKE_CAPABILITY_OCTAL_CONTROL, HANDSHAKE_CAPABILITY_COMPACT_READY, HANDSHAKE_OFFER_MAGIC, KEY_CONFIRM_MAGIC, KEY_CONFIRM_AUDIO_MAGIC, HANDSHAKE_RESPONSE_MAGIC, HANDSHAKE_READY_MAGIC, HANDSHAKE_READY_COMPACT_MAGIC, canonicalTranscript, sessionSalt, deriveHandshakeMaterial, makeOffer, makeResponse, transcriptBinding, sasCode, keyConfirm, keyConfirmAudioMode, readyConfirm, readyConfirmCompact, verifyReadyConfirm, equalBytes, encodeHandshakeOffer, decodeHandshakeOffer, encodeKeyConfirm, encodeKeyConfirmAudioMode, decodeKeyConfirm, decodeReadyConfirm, encodeReadyConfirm, encodeReadyConfirmCompact, encodeHandshakeResponse, decodeHandshakeResponse, type AcousticToneCount } from './handshake.ts'
export type { HandshakeOffer, HandshakeResponse, HandshakeMaterial } from './handshake.ts'
export { HANDSHAKE_FRAGMENT_DATA_BYTES, MAX_HANDSHAKE_FRAGMENTS, MAX_HANDSHAKE_MESSAGE_BYTES, fragmentHandshakeMessage, parseHandshakeFragment, AcousticFragmentReassembler } from './acoustic-fragment.ts'
export { AUDIO_PACE_FPS, opticalPaceFps, recommendOpticalPaceCode } from './pacing.ts'
export { CALIBRATION_STAGE_MS, CALIBRATION_END_STAGE, calibrationRates, calibrationFrameId, readCalibrationFrameId, selectCalibratedPaceCode } from './calibration.ts'
export type { CalibrationSample } from './calibration.ts'

export interface OpticalProfile {
  id: 'debug-100x60' | 'binary-200x120' | 'gray4-300x180' | 'gray4-400x240';
  gridWidth: number;
  gridHeight: number;
  bitsPerSymbol: 1 | 2;
  frameHoldCount: number;
  targetDisplayFps: number;
  expectedCameraFps: number;
  fecRatio: number;
}

export const DEBUG_PROFILE: OpticalProfile = {
  id: 'debug-100x60',
  gridWidth: 100,
  gridHeight: 60,
  bitsPerSymbol: 1,
  frameHoldCount: 2,
  targetDisplayFps: 30,
  expectedCameraFps: 30,
  fecRatio: 0,
}

export const BINARY_PROFILE: OpticalProfile = {
  id: 'binary-200x120',
  gridWidth: 200,
  gridHeight: 120,
  bitsPerSymbol: 1,
  frameHoldCount: 2,
  targetDisplayFps: 60,
  expectedCameraFps: 60,
  fecRatio: 0,
}

export const GRAY4_PROFILE: OpticalProfile = { id: 'gray4-300x180', gridWidth: 300, gridHeight: 180, bitsPerSymbol: 2, frameHoldCount: 2, targetDisplayFps: 60, expectedCameraFps: 60, fecRatio: 0.2 }
export const TARGET_PROFILE: OpticalProfile = { id: 'gray4-400x240', gridWidth: 400, gridHeight: 240, bitsPerSymbol: 2, frameHoldCount: 1, targetDisplayFps: 60, expectedCameraFps: 60, fecRatio: 0.2 }

export const OPTICAL_PROFILES = [DEBUG_PROFILE, BINARY_PROFILE, GRAY4_PROFILE, TARGET_PROFILE] as const
export function opticalProfileNumber(profile: OpticalProfile) { return OPTICAL_PROFILES.findIndex(item => item.id === profile.id) + 1 }

export const PROTOCOL_VERSION = 1
const MAGIC = 0x4f4d // "OM"
const HEADER_BYTES = 20
const FINDER_SIZE = 12
const FINDER_INSET = 2
const META_ROWS = 4
const DATA_INSET = 16

export interface OpticalFrameHeader {
  version: number;
  profileId: number;
  frameId: number;
  blockId: number;
  payloadLength: number;
  payloadCrc32: number;
}

export interface EncodedOpticalFrame {
  profile: OpticalProfile;
  width: number;
  height: number;
  cells: Uint8Array;
  header: OpticalFrameHeader;
  payload: Uint8Array;
}

export interface DecodedOpticalFrame {
  ok: true;
  header: OpticalFrameHeader;
  payload: Uint8Array;
  metadataAgreement: number;
}

export interface DecodeFailure {
  ok: false;
  reason: 'finder' | 'metadata' | 'torn-frame' | 'payload-length' | 'payload-crc';
  metadataAgreement?: number;
}

export type OpticalDecodeResult = DecodedOpticalFrame | DecodeFailure

export interface Point { x: number; y: number }
export interface OpticalBoundary {
  topLeft: Point;
  topRight: Point;
  bottomRight: Point;
  bottomLeft: Point;
  confidence: number;
}

export interface FinderReport {
  stage: 'top-left' | 'top-right' | 'bottom-right' | 'bottom-left' | 'complete';
  topLeft?: Point;
  topRight?: Point;
  bottomRight?: Point;
  bottomLeft?: Point;
}

export type OpticalImageDecode = OpticalDecodeResult & {
  boundary?: OpticalBoundary;
  sampledCells?: Uint8Array;
  symbolConfidence?: number;
}

export function frameDimensions(profile: OpticalProfile) {
  return { width: profile.gridWidth + DATA_INSET * 2, height: profile.gridHeight + DATA_INSET * 2 }
}

export function framePayloadCapacity(profile: OpticalProfile) {
  return Math.floor(profile.gridWidth * profile.gridHeight * profile.bitsPerSymbol / 8)
}

function cellIndex(width: number, x: number, y: number) { return y * width + x }
function setCell(cells: Uint8Array, width: number, x: number, y: number, value: number) { cells[cellIndex(width, x, y)] = value }
function getCell(cells: Uint8Array, width: number, x: number, y: number) { return cells[cellIndex(width, x, y)] || 0 }

function finderBit(x: number, y: number) {
  const centre = (FINDER_SIZE - 1) / 2, distance = Math.max(Math.abs(x - centre), Math.abs(y - centre))
  if (distance >= 4.5) return 0
  if (distance >= 3.5) return 1
  if (distance >= 2) return 0
  if (distance >= 1) return 1
  return 0
}

function writeFinder(cells: Uint8Array, width: number, x: number, y: number, white: number) {
  for (let row = 0; row < FINDER_SIZE; row += 1) for (let column = 0; column < FINDER_SIZE; column += 1) setCell(cells, width, x + column, y + row, finderBit(column, row) ? white : 0)
}

function metadataCoordinates(profile: OpticalProfile) {
  const { width, height } = frameDimensions(profile)
  const coordinates: Point[] = []
  for (let row = 0; row < META_ROWS; row += 1) for (let column = DATA_INSET; column < width - DATA_INSET; column += 1) coordinates.push({ x: column, y: FINDER_INSET + row })
  for (let row = 0; row < META_ROWS; row += 1) for (let column = DATA_INSET; column < width - DATA_INSET; column += 1) coordinates.push({ x: column, y: height - FINDER_INSET - META_ROWS + row })
  return coordinates
}

function headerBytes(header: OpticalFrameHeader) {
  const bytes = new Uint8Array(HEADER_BYTES)
  const view = new DataView(bytes.buffer)
  view.setUint16(0, MAGIC)
  bytes[2] = header.version
  bytes[3] = header.profileId
  view.setUint32(4, header.frameId)
  view.setUint32(8, header.blockId)
  view.setUint16(12, header.payloadLength)
  view.setUint32(14, header.payloadCrc32)
  view.setUint16(18, crc16(bytes.subarray(0, 18)))
  return bytes
}

function parseHeader(bytes: Uint8Array): OpticalFrameHeader | null {
  if (bytes.length !== HEADER_BYTES) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint16(0) !== MAGIC || bytes[2] !== PROTOCOL_VERSION || view.getUint16(18) !== crc16(bytes.subarray(0, 18))) return null
  return { version: bytes[2], profileId: bytes[3], frameId: view.getUint32(4), blockId: view.getUint32(8), payloadLength: view.getUint16(12), payloadCrc32: view.getUint32(14) }
}

function bytesToBits(bytes: Uint8Array) {
  const bits = new Uint8Array(bytes.length * 8)
  for (let offset = 0; offset < bytes.length; offset += 1) for (let bit = 0; bit < 8; bit += 1) bits[offset * 8 + bit] = (bytes[offset] >>> (7 - bit)) & 1
  return bits
}

function bitsToBytes(bits: Uint8Array, length: number) {
  const bytes = new Uint8Array(length)
  for (let offset = 0; offset < length * 8; offset += 1) bytes[Math.floor(offset / 8)] |= bits[offset] << (7 - (offset % 8))
  return bytes
}

export function encodeOpticalFrame(payload: Uint8Array, frameId: number, blockId: number, profile = DEBUG_PROFILE): EncodedOpticalFrame {
  if (payload.length > framePayloadCapacity(profile)) throw new Error(`Payload exceeds ${framePayloadCapacity(profile)} byte frame capacity`)
  const { width, height } = frameDimensions(profile)
  const white = profile.bitsPerSymbol === 2 ? 3 : 1
  const cells = new Uint8Array(width * height).fill(white)
  const header: OpticalFrameHeader = { version: PROTOCOL_VERSION, profileId: opticalProfileNumber(profile), frameId: frameId >>> 0, blockId: blockId >>> 0, payloadLength: payload.length, payloadCrc32: crc32(payload) }
  writeFinder(cells, width, FINDER_INSET, FINDER_INSET, white)
  writeFinder(cells, width, width - FINDER_INSET - FINDER_SIZE, FINDER_INSET, white)
  writeFinder(cells, width, width - FINDER_INSET - FINDER_SIZE, height - FINDER_INSET - FINDER_SIZE, white)
  writeFinder(cells, width, FINDER_INSET, height - FINDER_INSET - FINDER_SIZE, white)
  const metadata = metadataCoordinates(profile), headerBits = bytesToBits(headerBytes(header))
  for (let index = 0; index < metadata.length; index += 1) setCell(cells, width, metadata[index].x, metadata[index].y, headerBits[index % headerBits.length] ? white : 0)
  // Known alternating black/white rails provide per-frame luminance references.
  for (let row = 0; row < profile.gridHeight; row += 1) {
    if (profile.bitsPerSymbol === 1) {
      setCell(cells, width, DATA_INSET - 2, DATA_INSET + row, row & 1)
      setCell(cells, width, width - DATA_INSET + 1, DATA_INSET + row, (row + 1) & 1)
    } else for (let level = 0; level < 4; level += 1) {
      setCell(cells, width, DATA_INSET - 5 + level, DATA_INSET + row, level)
      setCell(cells, width, width - DATA_INSET + 1 + level, DATA_INSET + row, 3 - level)
    }
  }
  const payloadBits = bytesToBits(payload)
  for (let index = 0; index < profile.gridWidth * profile.gridHeight; index += 1) {
    const bit = index * profile.bitsPerSymbol
    const level = profile.bitsPerSymbol === 1 ? payloadBits[bit] || 0 : ((payloadBits[bit] || 0) << 1) | (payloadBits[bit + 1] || 0)
    setCell(cells, width, DATA_INSET + (index % profile.gridWidth), DATA_INSET + Math.floor(index / profile.gridWidth), level)
  }
  return { profile, width, height, cells, header, payload: payload.slice() }
}

function checkFinders(cells: Uint8Array, profile: OpticalProfile) {
  const { width, height } = frameDimensions(profile)
  const origins = [[FINDER_INSET, FINDER_INSET], [width - FINDER_INSET - FINDER_SIZE, FINDER_INSET], [width - FINDER_INSET - FINDER_SIZE, height - FINDER_INSET - FINDER_SIZE], [FINDER_INSET, height - FINDER_INSET - FINDER_SIZE]]
  let matches = 0
  for (const [originX, originY] of origins) for (let y = 0; y < FINDER_SIZE; y += 1) for (let x = 0; x < FINDER_SIZE; x += 1) if ((getCell(cells, width, originX + x, originY + y) >= (profile.bitsPerSymbol === 2 ? 2 : 1) ? 1 : 0) === finderBit(x, y)) matches += 1
  return matches / (origins.length * FINDER_SIZE * FINDER_SIZE)
}

function decodeMetadata(cells: Uint8Array, profile: OpticalProfile) {
  const { width } = frameDimensions(profile), coordinates = metadataCoordinates(profile), bitLength = HEADER_BYTES * 8, copies = Math.floor(coordinates.length / bitLength)
  const threshold = profile.bitsPerSymbol === 2 ? 2 : 1
  const majority = (begin: number, end: number) => {
    const votes = new Uint16Array(bitLength), counts = new Uint16Array(bitLength)
    for (let index = begin; index < end; index += 1) {
      const point = coordinates[index], bit = index % bitLength
      votes[bit] += getCell(cells, width, point.x, point.y) >= threshold ? 1 : 0
      counts[bit] += 1
    }
    const bits = new Uint8Array(bitLength)
    for (let bit = 0; bit < bitLength; bit += 1) bits[bit] = votes[bit] * 2 >= counts[bit] ? 1 : 0
    let header = parseHeader(bitsToBytes(bits, HEADER_BYTES))
    if (header) return header
    // A few spatially correlated camera errors can survive majority voting.
    // Try the least-certain bits against the header magic and CRC16.
    const uncertain = Array.from({ length: bitLength }, (_, index) => index).sort((left, right) => Math.abs(votes[left] * 2 - counts[left]) - Math.abs(votes[right] * 2 - counts[right]))
    const attempt = (indexes: number[]) => {
      for (const index of indexes) bits[index] ^= 1
      const result = parseHeader(bitsToBytes(bits, HEADER_BYTES))
      for (const index of indexes) bits[index] ^= 1
      return result
    }
    for (let first = 0; first < 12; first += 1) { header = attempt([uncertain[first]]); if (header) return header }
    for (let first = 0; first < 12; first += 1) for (let second = first + 1; second < 12; second += 1) { header = attempt([uncertain[first], uncertain[second]]); if (header) return header }
    for (let first = 0; first < 8; first += 1) for (let second = first + 1; second < 8; second += 1) for (let third = second + 1; third < 8; third += 1) { header = attempt([uncertain[first], uncertain[second], uncertain[third]]); if (header) return header }
    return null
  }
  const topLength = META_ROWS * profile.gridWidth
  const top = majority(0, topLength), bottom = majority(topLength, coordinates.length), combined = majority(0, coordinates.length)
  const headers: OpticalFrameHeader[] = []
  for (let copy = 0; copy < copies; copy += 1) {
    const bits = new Uint8Array(bitLength)
    for (let bit = 0; bit < bitLength; bit += 1) { const point = coordinates[copy * bitLength + bit]; bits[bit] = getCell(cells, width, point.x, point.y) >= threshold ? 1 : 0 }
    const header = parseHeader(bitsToBytes(bits, HEADER_BYTES)); if (header) headers.push(header)
  }
  if (top) headers.push(top)
  if (bottom) headers.push(bottom)
  if (combined) headers.push(combined)
  if (!headers.length) return { header: null, agreement: 0, torn: false }
  const signatures = new Map<string, OpticalFrameHeader>()
  for (const header of headers) signatures.set(`${header.frameId}:${header.blockId}:${header.payloadLength}:${header.payloadCrc32}`, header)
  const frequency = new Map<string, number>()
  for (const header of headers) { const key = `${header.frameId}:${header.blockId}:${header.payloadLength}:${header.payloadCrc32}`; frequency.set(key, (frequency.get(key) || 0) + 1) }
  const winner = [...frequency.entries()].sort((left, right) => right[1] - left[1])[0]
  return { header: signatures.get(winner[0]) || null, agreement: winner[1] / (copies + 3), torn: signatures.size > 1 }
}

export function decodeOpticalCells(cells: Uint8Array, profile = DEBUG_PROFILE): OpticalDecodeResult {
  const { width, height } = frameDimensions(profile)
  // Real cameras blur small finder rings. Redundant metadata plus CRC16/CRC32
  // still reject false positives after this acquisition check.
  if (cells.length !== width * height || checkFinders(cells, profile) < 0.7) return { ok: false, reason: 'finder' }
  const metadata = decodeMetadata(cells, profile)
  if (!metadata.header) return { ok: false, reason: 'metadata', metadataAgreement: metadata.agreement }
  if (metadata.torn) return { ok: false, reason: 'torn-frame', metadataAgreement: metadata.agreement }
  if (metadata.header.profileId !== opticalProfileNumber(profile)) return { ok: false, reason: 'metadata', metadataAgreement: metadata.agreement }
  if (metadata.header.payloadLength > framePayloadCapacity(profile)) return { ok: false, reason: 'payload-length', metadataAgreement: metadata.agreement }
  const bits = new Uint8Array(metadata.header.payloadLength * 8)
  for (let index = 0; index < bits.length; index += 1) {
    const cell = Math.floor(index / profile.bitsPerSymbol)
    const level = getCell(cells, width, DATA_INSET + (cell % profile.gridWidth), DATA_INSET + Math.floor(cell / profile.gridWidth))
    bits[index] = profile.bitsPerSymbol === 1 ? level : (level >>> (1 - (index & 1))) & 1
  }
  const payload = bitsToBytes(bits, metadata.header.payloadLength)
  if (crc32(payload) !== metadata.header.payloadCrc32) return { ok: false, reason: 'payload-crc', metadataAgreement: metadata.agreement }
  return { ok: true, header: metadata.header, payload, metadataAgreement: metadata.agreement }
}

export function deterministicPayload(frameId: number, length = framePayloadCapacity(DEBUG_PROFILE)) {
  const bytes = new Uint8Array(length)
  let state = (frameId ^ 0x9e3779b9) >>> 0
  for (let index = 0; index < bytes.length; index += 1) { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; bytes[index] = state & 0xff }
  return bytes
}

export function isDeterministicPayload(payload: Uint8Array, frameId: number) {
  const expected = deterministicPayload(frameId, payload.length)
  return expected.every((value, index) => value === payload[index])
}

export function crc16(bytes: Uint8Array) {
  let crc = 0xffff
  for (const value of bytes) { crc ^= value << 8; for (let bit = 0; bit < 8; bit += 1) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff }
  return crc
}

export function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff
  for (const value of bytes) { crc ^= value; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)) }
  return (crc ^ 0xffffffff) >>> 0
}

/** A DOM-independent image shape so this sampling path can also be benchmarked in Node. */
export interface OpticalImage { data?: Uint8ClampedArray; gray?: Uint8Array; grayStride?: number; width: number; height: number }

function luma(image: OpticalImage, x: number, y: number) {
  const safeX = Math.max(0, Math.min(image.width - 1, Math.round(x))), safeY = Math.max(0, Math.min(image.height - 1, Math.round(y)))
  if (image.gray) return image.gray[safeY * (image.grayStride || image.width) + safeX]
  if (!image.data) return 0
  const offset = (safeY * image.width + safeX) * 4
  return image.data[offset] * 0.2126 + image.data[offset + 1] * 0.7152 + image.data[offset + 2] * 0.0722
}

function sampleLuma(image: OpticalImage, x: number, y: number) {
  return luma(image, x, y)
}

const FINDER_PROBES = [0, 1, 2, 3, 4, 5, 7, 8, 9, 10, 11]

function finderScore(image: OpticalImage, centerX: number, centerY: number, radius: number) {
  let white = 0, black = 0, whiteCount = 0, blackCount = 0
  for (const row of FINDER_PROBES) for (const column of FINDER_PROBES) {
    const value = luma(image, centerX + ((column + 0.5) / FINDER_SIZE * 2 - 1) * radius, centerY + ((row + 0.5) / FINDER_SIZE * 2 - 1) * radius)
    if (finderBit(column, row)) { white += value; whiteCount += 1 } else { black += value; blackCount += 1 }
  }
  const whiteLevel = white / whiteCount, blackLevel = black / blackCount
  if (whiteLevel - blackLevel < 45) return 0
  const threshold = (whiteLevel + blackLevel) / 2
  let matches = 0
  for (const row of FINDER_PROBES) for (const column of FINDER_PROBES) {
    const value = luma(image, centerX + ((column + 0.5) / FINDER_SIZE * 2 - 1) * radius, centerY + ((row + 0.5) / FINDER_SIZE * 2 - 1) * radius)
    if ((value >= threshold ? 1 : 0) === finderBit(column, row)) matches += 1
  }
  const agreement = matches / (FINDER_PROBES.length * FINDER_PROBES.length)
  if (agreement < 0.66) return 0
  return agreement * (whiteLevel - blackLevel)
}

interface FinderMatch extends Point { radius: number; score: number }

function refineFinder(image: OpticalImage, initial: FinderMatch, distance: number) {
  let best = initial
  for (const span of [distance, 2]) {
    const seed = best
    for (let y = seed.y - span; y <= seed.y + span; y += 1) for (let x = seed.x - span; x <= seed.x + span; x += 1) for (const scale of [0.85, 0.95, 1.05, 1.15, 1.25]) {
      const radius = seed.radius * scale
      const score = finderScore(image, x, y, radius)
      if (score > best.score) best = { x, y, radius, score }
    }
  }
  return best
}

function findFinder(image: OpticalImage, minX: number, maxX: number, minY: number, maxY: number, profile: OpticalProfile, radiusHint?: number): FinderMatch | null {
  const logical = frameDimensions(profile), nominalCell = Math.min(image.width / logical.width, image.height / logical.height)
  const step = Math.max(3, Math.round(nominalCell * 0.65))
  const radii = radiusHint
    ? [0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.35].map(scale => radiusHint * scale)
    : [0.24, 0.32, 0.42, 0.55, 0.7, 0.9, 1.15, 1.45].map(scale => nominalCell * FINDER_SIZE / 2 * scale)
  let best: FinderMatch | null = null
  for (let y = minY + step; y < maxY - step; y += step) for (let x = minX + step; x < maxX - step; x += step) for (const radius of radii) {
    if (x - radius < 0 || x + radius >= image.width || y - radius < 0 || y + radius >= image.height) continue
    const score = finderScore(image, x, y, radius)
    if (!best || score > best.score) best = { x, y, radius, score }
  }
  if (!best || best.score < 55) return null
  return refineFinder(image, best, step * 2)
}

function findFinderNear(image: OpticalImage, predicted: Point, expectedRadius: number): FinderMatch | null {
  const span = Math.max(12, expectedRadius * 1.5), step = Math.max(2, Math.floor(expectedRadius / 8))
  let best: FinderMatch | null = null
  for (let y = predicted.y - span; y <= predicted.y + span; y += step) for (let x = predicted.x - span; x <= predicted.x + span; x += step) for (const scale of [0.8, 0.9, 1, 1.1, 1.2]) {
    const radius = expectedRadius * scale
    if (x - radius < 0 || x + radius >= image.width || y - radius < 0 || y + radius >= image.height) continue
    const score = finderScore(image, x, y, radius)
    if (!best || score > best.score) best = { x, y, radius, score }
  }
  return best && best.score >= 55 ? refineFinder(image, best, step * 2) : null
}

function solveLinearSystem(matrix: number[][], vector: number[]) {
  const size = vector.length
  for (let pivot = 0; pivot < size; pivot += 1) {
    let greatest = pivot
    for (let row = pivot + 1; row < size; row += 1) if (Math.abs(matrix[row][pivot]) > Math.abs(matrix[greatest][pivot])) greatest = row
    if (Math.abs(matrix[greatest][pivot]) < 1e-9) return null
    ;[matrix[pivot], matrix[greatest]] = [matrix[greatest], matrix[pivot]]; [vector[pivot], vector[greatest]] = [vector[greatest], vector[pivot]]
    const divisor = matrix[pivot][pivot]
    for (let column = pivot; column < size; column += 1) matrix[pivot][column] /= divisor
    vector[pivot] /= divisor
    for (let row = 0; row < size; row += 1) {
      if (row === pivot) continue
      const factor = matrix[row][pivot]
      for (let column = pivot; column < size; column += 1) matrix[row][column] -= factor * matrix[pivot][column]
      vector[row] -= factor * vector[pivot]
    }
  }
  return vector
}

function homography(from: Point[], to: Point[]) {
  const matrix: number[][] = [], vector: number[] = []
  for (let index = 0; index < 4; index += 1) {
    const { x, y } = from[index], { x: u, y: v } = to[index]
    matrix.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); vector.push(u)
    matrix.push([0, 0, 0, x, y, 1, -v * x, -v * y]); vector.push(v)
  }
  const values = solveLinearSystem(matrix, vector)
  return values ? [...values, 1] : null
}

function mapPoint(values: number[], point: Point): Point {
  const denominator = values[6] * point.x + values[7] * point.y + values[8]
  return { x: (values[0] * point.x + values[1] * point.y + values[2]) / denominator, y: (values[3] * point.x + values[4] * point.y + values[5]) / denominator }
}

export function transformForBoundary(boundary: OpticalBoundary, profile: OpticalProfile) {
  const { width, height } = frameDimensions(profile)
  return homography([{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }], [boundary.topLeft, boundary.topRight, boundary.bottomRight, boundary.bottomLeft])
}

/** Expensive first-frame detection. Later frames reuse the returned boundary. */
export function detectOpticalBoundary(image: OpticalImage, profile = DEBUG_PROFILE, report?: FinderReport): OpticalBoundary | null {
  if (report) report.stage = 'top-left'
  const initialTopLeft = findFinder(image, 0, image.width * 0.55, 0, image.height * 0.55, profile)
  if (!initialTopLeft) return null
  if (report) { report.topLeft = initialTopLeft; report.stage = 'top-right' }
  const initialTopRight = findFinder(image, image.width * 0.45, image.width, 0, image.height * 0.55, profile)
  if (!initialTopRight) return null
  if (report) { report.topRight = initialTopRight; report.stage = 'bottom-right' }
  const initialBottomRight = findFinder(image, Math.max(image.width * 0.45, initialTopRight.x - image.width * 0.16), Math.min(image.width, initialTopRight.x + image.width * 0.16), image.height * 0.45, image.height, profile, initialTopRight.radius)
  if (!initialBottomRight) return null
  if (report) { report.bottomRight = initialBottomRight; report.stage = 'bottom-left' }
  const radii = [initialTopLeft.radius, initialTopRight.radius, initialBottomRight.radius].sort((a, b) => a - b)
  const radiusHint = radii[1]
  const topLeft = findFinderNear(image, initialTopLeft, radiusHint)
  if (!topLeft) { if (report) report.stage = 'top-left'; return null }
  const topRight = findFinderNear(image, initialTopRight, radiusHint)
  if (!topRight) { if (report) report.stage = 'top-right'; return null }
  const bottomRight = findFinderNear(image, initialBottomRight, radiusHint)
  if (!bottomRight) { if (report) report.stage = 'bottom-right'; return null }
  // A strongly skewed screen is not a parallelogram in camera pixels. Search
  // beneath the known left marker instead of extrapolating the fourth corner
  // from the other three, while keeping the established finder size.
  const bottomLeft = findFinder(image, Math.max(0, topLeft.x - image.width * 0.18), Math.min(image.width * 0.55, topLeft.x + image.width * 0.18), image.height * 0.45, image.height, profile, (topLeft.radius + topRight.radius + bottomRight.radius) / 3)
  if (!bottomLeft) return null
  if (report) { report.bottomLeft = bottomLeft; report.stage = 'complete' }
  const { width, height } = frameDimensions(profile), center = FINDER_INSET + FINDER_SIZE / 2
  const transform = homography([{ x: center, y: center }, { x: width - center, y: center }, { x: width - center, y: height - center }, { x: center, y: height - center }], [topLeft, topRight, bottomRight, bottomLeft])
  if (!transform) return null
  return { topLeft: mapPoint(transform, { x: 0, y: 0 }), topRight: mapPoint(transform, { x: width, y: 0 }), bottomRight: mapPoint(transform, { x: width, y: height }), bottomLeft: mapPoint(transform, { x: 0, y: height }), confidence: 1 }
}

/** Samples only expected cell centres; it does not rectify a full camera bitmap. */
export function sampleOpticalCells(image: OpticalImage, boundary: OpticalBoundary, profile = DEBUG_PROFILE) {
  const transform = transformForBoundary(boundary, profile), { width, height } = frameDimensions(profile)
  if (!transform) return null
  const levels = profile.bitsPerSymbol === 2 ? 4 : 2
  const sums = new Float64Array(levels), counts = new Uint32Array(levels)
  const calibrate = (x: number, row: number, known: number) => {
    const source = mapPoint(transform, { x: x + 0.5, y: DATA_INSET + row + 0.5 })
    sums[known] += sampleLuma(image, source.x, source.y); counts[known] += 1
  }
  for (let row = 0; row < profile.gridHeight; row += 1) {
    if (profile.bitsPerSymbol === 1) {
      calibrate(DATA_INSET - 2, row, row & 1)
      calibrate(width - DATA_INSET + 1, row, (row + 1) & 1)
    } else for (let level = 0; level < 4; level += 1) {
      calibrate(DATA_INSET - 5 + level, row, level)
      calibrate(width - DATA_INSET + 1 + level, row, 3 - level)
    }
  }
  const means = Array.from(sums, (sum, index) => sum / Math.max(1, counts[index]))
  if (profile.bitsPerSymbol === 1) {
    const origins = [[FINDER_INSET, FINDER_INSET], [width - FINDER_INSET - FINDER_SIZE, FINDER_INSET], [width - FINDER_INSET - FINDER_SIZE, height - FINDER_INSET - FINDER_SIZE], [FINDER_INSET, height - FINDER_INSET - FINDER_SIZE]]
    const finderSums = [0, 0], finderCounts = [0, 0]
    for (const [originX, originY] of origins) for (let row = 0; row < FINDER_SIZE; row += 1) for (let column = 0; column < FINDER_SIZE; column += 1) {
      const source = mapPoint(transform, { x: originX + column + 0.5, y: originY + row + 0.5 }), known = finderBit(column, row)
      finderSums[known] += sampleLuma(image, source.x, source.y); finderCounts[known] += 1
    }
    const finderBlack = finderSums[0] / finderCounts[0], finderWhite = finderSums[1] / finderCounts[1]
    if (finderWhite - finderBlack > means[1] - means[0]) { means[0] = finderBlack; means[1] = finderWhite }
  }
  const thresholds = means.slice(0, -1).map((value, index) => (value + means[index + 1]) / 2)
  const contrast = Math.min(...means.slice(1).map((value, index) => value - means[index]))
  const confidence = Math.max(0, Math.min(1, contrast / (profile.bitsPerSymbol === 2 ? 42 : 128)))
  const cells = new Uint8Array(width * height)
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const px = x + 0.5, py = y + 0.5, denominator = transform[6] * px + transform[7] * py + transform[8]
    const sourceX = (transform[0] * px + transform[1] * py + transform[2]) / denominator
    const sourceY = (transform[3] * px + transform[4] * py + transform[5]) / denominator
    const value = sampleLuma(image, sourceX, sourceY)
    let level = 0
    while (level < thresholds.length && value >= thresholds[level]) level += 1
    cells[cellIndex(width, x, y)] = level
  }
  return { cells, symbolConfidence: confidence }
}

export function decodeOpticalImage(image: OpticalImage, profile = DEBUG_PROFILE, previousBoundary?: OpticalBoundary): OpticalImageDecode {
  const boundary = previousBoundary || detectOpticalBoundary(image, profile)
  if (!boundary) return { ok: false, reason: 'finder' }
  const sampled = sampleOpticalCells(image, boundary, profile)
  if (!sampled) return { ok: false, reason: 'finder', boundary }
  const decoded = decodeOpticalCells(sampled.cells, profile)
  return { ...decoded, boundary, sampledCells: sampled.cells, symbolConfidence: sampled.symbolConfidence }
}

/** Test helper and browser-independent renderer input for the Canvas renderer. */
export function rasterizeOpticalCells(frame: EncodedOpticalFrame, cellPixels = 8): OpticalImage {
  const width = frame.width * cellPixels, height = frame.height * cellPixels, data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const level = frame.cells[cellIndex(frame.width, Math.floor(x / cellPixels), Math.floor(y / cellPixels))]
    const value = level * (255 / (frame.profile.bitsPerSymbol === 2 ? 3 : 1)), offset = (y * width + x) * 4
    data[offset] = value; data[offset + 1] = value; data[offset + 2] = value; data[offset + 3] = 255
  }
  return { data, width, height }
}
