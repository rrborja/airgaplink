/** Non-authenticating pre-pairing quality hint. This may only slow display
 * turnover; it must never establish trust, change keys, or bypass the SAS. */
import { ControlType, type ControlPacket } from './control.ts'
export const OPTICAL_QUALITY_VERSION = 1
export const OPTICAL_QUALITY_CRC_FAILURE = 1
export const OPTICAL_OFFER_HOLD_MS = [400, 900, 1500] as const

export function makeOpticalQualityPayload(profileId: number, holdCode: number) {
  if (!Number.isInteger(profileId) || profileId < 1 || profileId > 255 || !Number.isInteger(holdCode) || holdCode < 1 || holdCode >= OPTICAL_OFFER_HOLD_MS.length) throw new Error('Invalid optical quality hint')
  return Uint8Array.of(OPTICAL_QUALITY_VERSION, profileId, OPTICAL_QUALITY_CRC_FAILURE, holdCode)
}

export function readOpticalQualityPayload(payload: Uint8Array) {
  if (payload.length !== 4 || payload[0] !== OPTICAL_QUALITY_VERSION || payload[1] < 1 || payload[2] !== OPTICAL_QUALITY_CRC_FAILURE || payload[3] < 1 || payload[3] >= OPTICAL_OFFER_HOLD_MS.length) return null
  return { profileId: payload[1], holdCode: payload[3] }
}

export function nextOpticalOfferHold(currentMs: number, activeSessionId: number, activeProfileId: number, packet: ControlPacket) {
  if (packet.type !== ControlType.OPTICAL_QUALITY || packet.transferId !== activeSessionId) return currentMs
  const hint = readOpticalQualityPayload(packet.payload)
  if (!hint || hint.profileId !== activeProfileId) return currentMs
  return Math.max(currentMs, OPTICAL_OFFER_HOLD_MS[hint.holdCode])
}
