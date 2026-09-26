import { FSK_SYMBOL_SECONDS } from './control.ts'
import { OCTAL_FAST_SYMBOL_SECONDS } from './octal-fsk.ts'
import { HANDSHAKE_CAPABILITY_ADAPTIVE_AUDIO, HANDSHAKE_CAPABILITY_COMPACT_READY, HANDSHAKE_CAPABILITY_FAST_OCTAL, HANDSHAKE_CAPABILITY_FAST_READY, HANDSHAKE_CAPABILITY_HEX_FSK, HANDSHAKE_CAPABILITY_OFDM, HANDSHAKE_CAPABILITY_OCTAL_CONTROL, HANDSHAKE_CAPABILITY_OCTAL_FSK, HANDSHAKE_CAPABILITY_QUAD_CONTROL, HANDSHAKE_CAPABILITY_QUAD_FSK, type AcousticToneCount } from './handshake.ts'

/** Retries keep the transcript-selected physical mode. A failed high-speed
 * attempt needs a fresh offer rather than changing waveform mid-response. */
export function responseToneCount(capabilities: number, round: number): AcousticToneCount {
  if (!Number.isInteger(round) || round < 1) throw new Error('Invalid response round')
  if ((capabilities & (HANDSHAKE_CAPABILITY_ADAPTIVE_AUDIO | HANDSHAKE_CAPABILITY_OFDM)) === (HANDSHAKE_CAPABILITY_ADAPTIVE_AUDIO | HANDSHAKE_CAPABILITY_OFDM)) return 32
  if ((capabilities & (HANDSHAKE_CAPABILITY_ADAPTIVE_AUDIO | HANDSHAKE_CAPABILITY_HEX_FSK)) === (HANDSHAKE_CAPABILITY_ADAPTIVE_AUDIO | HANDSHAKE_CAPABILITY_HEX_FSK)) return 16
  if (capabilities & HANDSHAKE_CAPABILITY_OCTAL_FSK) return 8
  if (capabilities & HANDSHAKE_CAPABILITY_QUAD_FSK) return 4
  return 2
}

export function runtimeToneAllowed(capabilities: number, mode: AcousticToneCount) {
  if (capabilities & HANDSHAKE_CAPABILITY_ADAPTIVE_AUDIO) {
    if (capabilities & HANDSHAKE_CAPABILITY_OFDM) return mode === 32
    if (capabilities & HANDSHAKE_CAPABILITY_HEX_FSK) return mode === 16
    if (capabilities & HANDSHAKE_CAPABILITY_OCTAL_FSK) return mode === 8
  }
  if ((capabilities & (HANDSHAKE_CAPABILITY_OCTAL_FSK | HANDSHAKE_CAPABILITY_OCTAL_CONTROL)) === (HANDSHAKE_CAPABILITY_OCTAL_FSK | HANDSHAKE_CAPABILITY_OCTAL_CONTROL)) return mode === 8
  return mode === 2 || (mode === 4 && !!(capabilities & HANDSHAKE_CAPABILITY_QUAD_CONTROL)) || (mode === 8 && !!(capabilities & HANDSHAKE_CAPABILITY_OCTAL_CONTROL))
}

/** Keep the authenticated response mode through READY and compact ACKs. */
export function runtimeToneCount(capabilities: number, heardMode: AcousticToneCount): AcousticToneCount {
  if ((capabilities & (HANDSHAKE_CAPABILITY_ADAPTIVE_AUDIO | HANDSHAKE_CAPABILITY_OFDM)) === (HANDSHAKE_CAPABILITY_ADAPTIVE_AUDIO | HANDSHAKE_CAPABILITY_OFDM)) {
    if (heardMode !== 32) throw new Error('OFDM session attempted to downgrade')
    return 32
  }
  if ((capabilities & (HANDSHAKE_CAPABILITY_ADAPTIVE_AUDIO | HANDSHAKE_CAPABILITY_HEX_FSK)) === (HANDSHAKE_CAPABILITY_ADAPTIVE_AUDIO | HANDSHAKE_CAPABILITY_HEX_FSK)) {
    if (heardMode !== 16) throw new Error('16-FSK session attempted to downgrade')
    return 16
  }
  if ((capabilities & (HANDSHAKE_CAPABILITY_OCTAL_FSK | HANDSHAKE_CAPABILITY_OCTAL_CONTROL)) === (HANDSHAKE_CAPABILITY_OCTAL_FSK | HANDSHAKE_CAPABILITY_OCTAL_CONTROL)) {
    if (heardMode !== 8) throw new Error('Eight-tone session attempted to downgrade')
    return 8
  }
  if (heardMode === 8 && runtimeToneAllowed(capabilities, 8)) return 8
  if (heardMode >= 4 && runtimeToneAllowed(capabilities, 4)) return 4
  return 2
}

export const AUDIO_MODE_SELECT_MAGIC = Uint8Array.of(0x41, 0x4d, 0x53, 1) // AMS1
export interface AudioProbeQuality { octalDecoded: boolean; hexDecoded: boolean; estimatedSnrDb: number; ofdmDecoded?: boolean; ofdmSnrDb?: number }
/** Conservative: require both CRC-valid probes and a strong high-band tone margin. */
export function chooseAdaptiveAudioMode(capabilities: number, quality: AudioProbeQuality): 8 | 16 | 32 {
  if ((capabilities & (HANDSHAKE_CAPABILITY_ADAPTIVE_AUDIO | HANDSHAKE_CAPABILITY_OFDM)) === (HANDSHAKE_CAPABILITY_ADAPTIVE_AUDIO | HANDSHAKE_CAPABILITY_OFDM) && quality.octalDecoded && quality.hexDecoded && quality.ofdmDecoded && (quality.ofdmSnrDb || 0) >= 12 && quality.estimatedSnrDb >= 9) return 32
  return (capabilities & (HANDSHAKE_CAPABILITY_ADAPTIVE_AUDIO | HANDSHAKE_CAPABILITY_HEX_FSK)) === (HANDSHAKE_CAPABILITY_ADAPTIVE_AUDIO | HANDSHAKE_CAPABILITY_HEX_FSK) && quality.octalDecoded && quality.hexDecoded && quality.estimatedSnrDb >= 9 ? 16 : 8
}
export function nextSaferAcousticMode(mode: 8 | 16 | 32): 8 | 16 | null { return mode === 32 ? 16 : mode === 16 ? 8 : null }
/** Retry the entire cryptographic offer at a safer mode. Changing waveform
 * inside one transcript would permit a silent downgrade, so never do that. */
export function acousticFallbackDecision(mode: 8 | 16 | 32, elapsedMs: number, silenceMs: number, receivedFragments: number): 8 | 16 | null {
  const safer = nextSaferAcousticMode(mode)
  if (!safer || !Number.isFinite(elapsedMs) || !Number.isFinite(silenceMs) || receivedFragments < 0) return null
  if (!receivedFragments && elapsedMs > 7500) return safer
  if (elapsedMs > 22_000 && silenceMs > 5000) return safer
  return null
}
/** The pre-auth optical choice is only a proposal; the HMAC-bound response
 * must repeat it. An old 8-FSK peer may answer after our 8-FSK timeout. */
export function selectedAcousticModeMatches(selectedMode: 8 | 16 | 32 | undefined, responseCapabilities: number, heardMode: AcousticToneCount) {
  if (selectedMode === undefined) return !(responseCapabilities & HANDSHAKE_CAPABILITY_ADAPTIVE_AUDIO)
  if (heardMode !== selectedMode) return false
  if (!(responseCapabilities & HANDSHAKE_CAPABILITY_ADAPTIVE_AUDIO)) return selectedMode === 8
  if (selectedMode === 32) return !!(responseCapabilities & HANDSHAKE_CAPABILITY_OFDM)
  return !(responseCapabilities & HANDSHAKE_CAPABILITY_OFDM) && !!(responseCapabilities & HANDSHAKE_CAPABILITY_HEX_FSK) === (selectedMode === 16)
}
export function encodeAudioModeSelect(sessionId: Uint8Array, mode: 8 | 16 | 32, probeMask: number, estimatedSnrDb: number) {
  if (sessionId.length !== 16 || (mode !== 8 && mode !== 16 && mode !== 32) || !Number.isInteger(probeMask) || probeMask < 0 || probeMask > 7) throw new Error('Invalid acoustic mode selection')
  const bytes = new Uint8Array(23)
  bytes.set(AUDIO_MODE_SELECT_MAGIC); bytes.set(sessionId, 4); bytes[20] = mode; bytes[21] = probeMask
  bytes[22] = Math.max(0, Math.min(255, Math.round(estimatedSnrDb + 32)))
  return bytes
}
export function decodeAudioModeSelect(bytes: Uint8Array) {
  if (bytes.length !== 23 || bytes.some((value, index) => index < 4 && value !== AUDIO_MODE_SELECT_MAGIC[index]) || (bytes[20] !== 8 && bytes[20] !== 16 && bytes[20] !== 32) || bytes[21] > 7) return null
  return { sessionId: bytes.slice(4, 20), mode: bytes[20] as 8 | 16 | 32, probeMask: bytes[21], estimatedSnrDb: bytes[22] - 32 }
}

/** AHY2 is a separate protocol feature, not implied by eight-tone FSK. */
export function compactReadyNegotiated(offerCapabilities: number, responseCapabilities: number) {
  return !!((offerCapabilities & responseCapabilities) & HANDSHAKE_CAPABILITY_COMPACT_READY)
}

export function fastReadyNegotiated(offerCapabilities: number, responseCapabilities: number) {
  return !!((offerCapabilities & responseCapabilities) & HANDSHAKE_CAPABILITY_FAST_READY)
}

export function octalSymbolSeconds(offerCapabilities: number, responseCapabilities: number) {
  return (offerCapabilities & responseCapabilities & HANDSHAKE_CAPABILITY_FAST_OCTAL) &&
    (responseCapabilities & (HANDSHAKE_CAPABILITY_OCTAL_FSK | HANDSHAKE_CAPABILITY_OCTAL_CONTROL)) === (HANDSHAKE_CAPABILITY_OCTAL_FSK | HANDSHAKE_CAPABILITY_OCTAL_CONTROL)
    ? OCTAL_FAST_SYMBOL_SECONDS : FSK_SYMBOL_SECONDS
}
