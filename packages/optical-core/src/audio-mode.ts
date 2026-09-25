import { FSK_SYMBOL_SECONDS } from './control.ts'
import { OCTAL_FAST_SYMBOL_SECONDS } from './octal-fsk.ts'
import { HANDSHAKE_CAPABILITY_COMPACT_READY, HANDSHAKE_CAPABILITY_FAST_OCTAL, HANDSHAKE_CAPABILITY_FAST_READY, HANDSHAKE_CAPABILITY_OCTAL_CONTROL, HANDSHAKE_CAPABILITY_OCTAL_FSK, HANDSHAKE_CAPABILITY_QUAD_CONTROL, HANDSHAKE_CAPABILITY_QUAD_FSK, type AcousticToneCount } from './handshake.ts'

/** Retries keep the negotiated physical mode. A new eight-tone pair never
 * changes waveform mid-handshake because that would also downgrade READY/ACKs. */
export function responseToneCount(capabilities: number, round: number): AcousticToneCount {
  if (!Number.isInteger(round) || round < 1) throw new Error('Invalid response round')
  if (capabilities & HANDSHAKE_CAPABILITY_OCTAL_FSK) return 8
  if (capabilities & HANDSHAKE_CAPABILITY_QUAD_FSK) return 4
  return 2
}

export function runtimeToneAllowed(capabilities: number, mode: AcousticToneCount) {
  if ((capabilities & (HANDSHAKE_CAPABILITY_OCTAL_FSK | HANDSHAKE_CAPABILITY_OCTAL_CONTROL)) === (HANDSHAKE_CAPABILITY_OCTAL_FSK | HANDSHAKE_CAPABILITY_OCTAL_CONTROL)) return mode === 8
  return mode === 2 || (mode === 4 && !!(capabilities & HANDSHAKE_CAPABILITY_QUAD_CONTROL)) || (mode === 8 && !!(capabilities & HANDSHAKE_CAPABILITY_OCTAL_CONTROL))
}

/** Keep eight-tone from first response through compact ACKs when both sides
 * negotiate it. Lower modes are solely for peers lacking that capability. */
export function runtimeToneCount(capabilities: number, heardMode: AcousticToneCount): AcousticToneCount {
  if ((capabilities & (HANDSHAKE_CAPABILITY_OCTAL_FSK | HANDSHAKE_CAPABILITY_OCTAL_CONTROL)) === (HANDSHAKE_CAPABILITY_OCTAL_FSK | HANDSHAKE_CAPABILITY_OCTAL_CONTROL)) {
    if (heardMode !== 8) throw new Error('Eight-tone session attempted to downgrade')
    return 8
  }
  if (heardMode === 8 && runtimeToneAllowed(capabilities, 8)) return 8
  if (heardMode >= 4 && runtimeToneAllowed(capabilities, 4)) return 4
  return 2
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
