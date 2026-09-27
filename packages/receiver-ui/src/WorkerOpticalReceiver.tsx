import { useEffect, useRef, useState } from 'react'
import { ReedSolomonErasure } from '@digitaldefiance/reed-solomon-erasure.wasm/browser'
import reedSolomonWasmUrl from '@digitaldefiance/reed-solomon-erasure.wasm/wasm?url'
import { AcousticFragmentReassembler, CALIBRATION_END_STAGE, CALIBRATION_STAGE_MS, ControlType, DEBUG_PROFILE, HANDSHAKE_CAPABILITY_COMPACT_READY, HANDSHAKE_CAPABILITY_DENSE_RESPONSE, HANDSHAKE_CAPABILITY_OCTAL_CONTROL, HANDSHAKE_CAPABILITY_OCTAL_FSK, HANDSHAKE_CAPABILITY_QUAD_CONTROL, HANDSHAKE_CAPABILITY_QUAD_FSK, HANDSHAKE_CAPABILITY_RESPONSE_PARITY, OPTICAL_PROFILES, OpticalBlockCollector, PROTOCOL_VERSION, ReedSolomonBlockCodec, TRANSFER_MANIFEST_BYTES, aesGcmDecrypt, compactReadyNegotiated, decodeHandshakeNack, decodeHandshakeOffer, decodeKeyConfirm, deriveHandshakeMaterial, encodeHandshakeResponse, encodeReadyConfirm, encodeReadyConfirmCompact, equalBytes, fragmentDenseHandshakeResponse, fragmentHandshakeMessage, generateEphemeralKeyPair, keyConfirm, keyConfirmAudioMode, makeResponse, opticalBlockAad, opticalNonce, calibrationRates, encodeCompactFskPacket, encodeFskPacket, encodeOctalCompactFskPacket, encodeOctalFskHandshakePacket, encodeOctalFskPacket, encodeQuadCompactFskPacket, encodeQuadFskHandshakePacket, encodeQuadFskPacket, frameDimensions, isDeterministicPayload, makeBlockStatusPayload, makeCompactStatusPayload, opticalPaceFps, opticalProfileNumber, readCalibrationFrameId, responseToneCount, runtimeToneAllowed, selectCalibratedPaceCode, selectHandshakeNackRetransmissions, unpackOpticalSymbol, unpackTransferManifest, readyConfirm, readyConfirmCompact, writeOpticalCellRgba, type AcousticToneCount, type ControlPacket, type HandshakeMaterial, type HandshakeOffer, type OpticalImageDecode, type OpticalProfile, type TransferManifest } from '@qrcopy/optical-core'
import { HANDSHAKE_CAPABILITY_FAST_OCTAL, HANDSHAKE_CAPABILITY_FAST_READY, fastReadyNegotiated, fastReadyPackets, octalSymbolSeconds, readyConfirmFast, rotateHandshakePackets } from '@qrcopy/optical-core'
import { isFreshHandshakeNackRequest } from '@qrcopy/optical-core'
import { HANDSHAKE_CAPABILITY_ADAPTIVE_AUDIO, HANDSHAKE_CAPABILITY_HEX_FSK, HANDSHAKE_CAPABILITY_OFDM, decodeAudioModeSelect, denseHandshakeSessionTag, encodeHexCompactFskPacket, encodeHexFskHandshakePacket, encodeHexFskPacket, encodeOfdmCompactPacket, encodeOfdmHandshakePacket, encodeOfdmPacket } from '@qrcopy/optical-core'
import { AdaptiveOpticalPace, countRecoverableCalibrationVisits } from '@qrcopy/optical-core'
import { RGB_BOOTSTRAP_FRAME_TAG, makeOpticalQualityPayload } from '@qrcopy/optical-core'
import { HANDSHAKE_CAPABILITY_SPARSE_STREAM, ReceivedBlockMap, cyclicOpticalBlockAad, cyclicOpticalNonce, makeMissingHintPayload, transferCompletionTag } from '@qrcopy/optical-core'
import { CameraFrameMeter, applyShortExposure, cameraSettingsSummary, restoreAutoExposure, type CameraSettingsSummary } from './camera-telemetry'
import { LocalOpticalSink } from './local-sink'
import { IndexedDbOpticalSink } from './indexeddb-sink'

type OpticalSink = LocalOpticalSink | IndexedDbOpticalSink
type StorageMode = 'checking' | 'opfs' | 'indexeddb' | 'memory'
interface FileReceiveState { id: number | null; collectors: Map<string, OpticalBlockCollector>; blocks: Map<number, Uint8Array>; received: ReceivedBlockMap; receivedBytes: number; manifest: TransferManifest | null; sink: OpticalSink | null; sinkOpening: boolean; storageError: boolean; verifying: boolean }
function emptyFileState(): FileReceiveState { return { id: null, collectors: new Map(), blocks: new Map(), received: new ReceivedBlockMap(), receivedBytes: 0, manifest: null, sink: null, sinkOpening: false, storageError: false, verifying: false } }
type ConnectionMode = 'direct' | 'audio'
type ReceiverHandshakeState = 'IDLE' | 'WAITING_FOR_OFFER' | 'OFFER_RECEIVED' | 'PROBING_CHANNEL' | 'WAITING_FOR_MODE_SELECTION' | 'GENERATING_RESPONSE' | 'SENDING_AUDIO_RESPONSE' | 'DERIVING_KEYS' | 'AWAITING_USER_VERIFICATION' | 'WAITING_FOR_KEY_CONFIRM' | 'SENDING_READY' | 'WAITING_FOR_SENDER' | 'ESTABLISHED' | 'FAILED' | 'CANCELLED'

export function WorkerOpticalReceiver() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const cameraTrackRef = useRef<MediaStreamTrack | null>(null)
  const gridRef = useRef<HTMLCanvasElement>(null)
  const workerRef = useRef<Worker | null>(null)
  const wasmBytes = useRef<Uint8Array | null>(null), recoveryCodec = useRef<ReedSolomonBlockCodec | null>(null), fileState = useRef<FileReceiveState>(emptyFileState())
  const speaker = useRef<AudioContext | null>(null), speakerTimer = useRef<number | null>(null), completionStopTimer = useRef<number | null>(null), readyPlaybackTimer = useRef<number | null>(null), audioSequence = useRef(0), verified = useRef(false), readySent = useRef(false), alignmentSeen = useRef(false), opticalLost = useRef(false), lastOpticalAt = useRef(0), resumeRepeats = useRef(0), completeSignalsSent = useRef(0), nextAudioStart = useRef(0)
  const handshakeRef = useRef<{ state: ReceiverHandshakeState; offer?: HandshakeOffer; responseCapabilities?: number; privateKey?: Uint8Array; publicKey?: Uint8Array; material?: HandshakeMaterial; responseMessage?: Uint8Array; responsePackets?: ControlPacket[]; nextFullRetryAt?: number; lastNackRequestId?: number; lastNackAt?: number; selectivePackets?: number; selectedMode?: 8 | 16 | 32; acousticAirtimeSeconds?: number; readyMessage?: Uint8Array; fastReadyMac?: Uint8Array; audioMode?: AcousticToneCount; responseRounds: number; readyRounds: number; outgoing: ControlPacket[]; reassembler: AcousticFragmentReassembler }>({ state: 'WAITING_FOR_OFFER', responseRounds: 0, readyRounds: 0, outgoing: [], reassembler: new AcousticFragmentReassembler() })
  const fileDecodeStats = useRef({ symbols: 0, usefulShards: 0, usefulShardBytes: 0, recoveredBlocks: 0, invalidSymbols: 0, sessionRejects: 0, manifestShards: 0, lastBlock: -1 })
  const sparseStorageAvailable = useRef(false), sparseStorageProbeDone = useRef(false)
  const completionTagRef = useRef<Uint8Array | null>(null), lastPaceReportAt = useRef(0), lastHintAt = useRef(0), hintCursor = useRef(0), duplicateBlocks = useRef(0), wastedFrames = useRef(0)
  const qualityFeedbackRef = useRef<{ transferId: number; failures: number; nextAt: number } | null>(null)
  const fileStarted = useRef(0)
  const pacingCode = useRef(0)
  const adaptivePace = useRef(new AdaptiveOpticalPace(DEBUG_PROFILE, 1))
  const calibrationMode = useRef<'idle' | 'probing' | 'selected' | 'transferring'>('idle')
  const selectedPaceCode = useRef(0)
  const calibrationSamples = useRef(new Map<number, { firstSequence: number; lastSequence: number; seen: Set<number>; shards: Set<number>; firstAt: number; lastAt: number }>())
  useEffect(() => () => { void fileState.current.sink?.remove() }, [])
  const [profile, setProfile] = useState<OpticalProfile>(DEBUG_PROFILE)
  const [connectionMode, setConnectionMode] = useState<ConnectionMode>('direct')
  const [audioSessionId, setAudioSessionId] = useState(() => crypto.getRandomValues(new Uint32Array(1))[0])
  const audioSessionIdRef = useRef(audioSessionId)
  const [task, setTask] = useState<'file' | 'benchmark'>('file'), [fileStatus, setFileStatus] = useState('Loading local erasure codec…'), [downloadUrl, setDownloadUrl] = useState<string | null>(null)
  const [fileProgress, setFileProgress] = useState({ blocks: 0, totalBlocks: 0, receivedBytes: 0, totalBytes: 0, verifiedBytes: 0, elapsedSeconds: 0 })
  const [speakerStatus, setSpeakerStatus] = useState('Speaker feedback off'), [audioPacketsSent, setAudioPacketsSent] = useState(0)
  const [opticalLink, setOpticalLink] = useState<'searching' | 'aligned' | 'interrupted'>('searching')
  const [recommendedPace, setRecommendedPace] = useState(0)
  const [paceDiagnostics, setPaceDiagnostics] = useState({ validFps: 0, uniqueFps: 0, invalidFps: 0, senderFps: 0, usefulKBps: 0, storedKBps: 0, cameraFps: 0 })
  const [opticalRecovery, setOpticalRecovery] = useState({ recovered: 0, candidates: 0, headerFrame: -1, payloadBytes: 0 })
  const [cameraActive, setCameraActive] = useState(true)
  const [cameraSettings, setCameraSettings] = useState<CameraSettingsSummary | null>(null)
  const [cameraControlStatus, setCameraControlStatus] = useState('')
  const [diskStorage, setDiskStorage] = useState<StorageMode>('checking')
  const [handshakeState, setHandshakeState] = useState<ReceiverHandshakeState>('WAITING_FOR_OFFER'), [sas, setSas] = useState<string | null>(null), [responseRounds, setResponseRounds] = useState(0)
  const [handsFreePairing, setHandsFreePairing] = useState(true), [verificationSeconds, setVerificationSeconds] = useState(3)
  const sasManuallyVerifiedRef = useRef(false)
  const [storageProblem, setStorageProblem] = useState('')
  const diskStorageRef = useRef<StorageMode>('checking')
  const [status, setStatus] = useState({ camera: 'starting', finder: 'searching', reason: 'starting', recovery: 'none', frame: -1, valid: 0, failed: 0, unique: 0, processingFps: 0, validFps: 0, usefulKBps: 0, decodeMs: 0, acquireMs: 0, drawMs: 0, readMs: 0, sampleMs: 0, crcMs: 0, pixelPath: 'starting', gpuDiagnostic: 'not tested', pixelsPerCell: 0, confidence: 0, deterministic: false, boundary: 'searching', fileSymbols: 0, invalidSymbols: 0, sessionRejects: 0, manifestShards: 0, lastFileBlock: -1 })
  useEffect(() => { let cancelled = false; void fetch(reedSolomonWasmUrl).then(response => response.arrayBuffer()).then(bytes => { if (!cancelled) {
    wasmBytes.current = new Uint8Array(bytes)
    // The current WASM wrapper fails repeated reconstructions on one instance.
    // Keep one downloaded module binary and isolate each recovery call.
    recoveryCodec.current = new ReedSolomonBlockCodec({ encode: () => { throw new Error('Receiver does not encode shards') }, reconstruct: (shards, sourceCount, repairCount, available) => ReedSolomonErasure.fromBytes(wasmBytes.current!.buffer as ArrayBuffer).reconstruct(shards, sourceCount, repairCount, available) })
    setFileStatus('Waiting for optical ZIP symbols')
  } }).catch(() => setFileStatus('Could not load local erasure codec')); return () => { cancelled = true } }, [])
  useEffect(() => {
    let cancelled = false
    void (async () => {
      let root: FileSystemDirectoryHandle | null = null, name = ''
      try {
        if (!navigator.storage?.getDirectory) throw new Error('Browser-private disk unavailable')
        root = await navigator.storage.getDirectory()
        name = `optical-storage-check-${crypto.randomUUID()}`
        const handle = await root.getFileHandle(name, { create: true })
        const writable = await handle.createWritable()
        await writable.close()
        await root.removeEntry(name)
        if (!cancelled) { diskStorageRef.current = 'opfs'; setDiskStorage('opfs') }
      } catch (error) {
        if (root && name) await root.removeEntry(name).catch(() => {})
        const indexedDb = await IndexedDbOpticalSink.probeWithReason()
        if (!cancelled) {
          const mode = indexedDb.available ? 'indexeddb' : 'memory'
          diskStorageRef.current = mode; setDiskStorage(mode)
          if (!indexedDb.available) setStorageProblem(`File storage: ${error instanceof Error ? error.message : String(error)}; IndexedDB: ${indexedDb.reason}`)
        }
      }
    })()
    return () => { cancelled = true }
  }, [])
  useEffect(() => { let cancelled = false; void IndexedDbOpticalSink.probe().then(available => { if (!cancelled) { sparseStorageAvailable.current = available; sparseStorageProbeDone.current = true } }).catch(() => { if (!cancelled) sparseStorageProbeDone.current = true }); return () => { cancelled = true } }, [])
  const stopSpeaker = () => { if (speakerTimer.current !== null) window.clearInterval(speakerTimer.current); speakerTimer.current = null; if (completionStopTimer.current !== null) window.clearTimeout(completionStopTimer.current); completionStopTimer.current = null; if (readyPlaybackTimer.current !== null) window.clearTimeout(readyPlaybackTimer.current); readyPlaybackTimer.current = null; void speaker.current?.close(); speaker.current = null; nextAudioStart.current = 0; setSpeakerStatus('Speaker feedback off') }
  useEffect(() => () => stopSpeaker(), [])
  const sendAcousticStatus = () => {
    const context = speaker.current, state = fileState.current, manifest = state.manifest
    if (!context) return
    // Do not queue stale block bitmaps behind an in-flight tone. The next
    // periodic packet will contain the newest stored-block set. Completion is
    // allowed one slot after the current tone so the sender can stop promptly.
    if (!verified.current && nextAudioStart.current > context.currentTime + 0.2) return
    let type: ControlType, payload: Uint8Array, compact = false
    let transferId = connectionMode === 'audio' ? audioSessionIdRef.current : state.id
    if (transferId === null) return
    const handshake = handshakeRef.current
    if (connectionMode === 'audio' && handshake.outgoing.length === 0 && handshake.offer) {
      const compactId = audioSessionIdRef.current
      if ((handshake.state === 'AWAITING_USER_VERIFICATION' || handshake.state === 'WAITING_FOR_KEY_CONFIRM') && handshake.responsePackets && performance.now() >= (handshake.nextFullRetryAt || Infinity)) {
        handshake.outgoing = rotateHandshakePackets(handshake.responsePackets, handshake.responseRounds).map((packet, index) => ({ ...packet, sequence: (audioSequence.current + index) & 0xffff }))
        audioSequence.current = (audioSequence.current + handshake.outgoing.length) & 0xffff
        handshake.responseRounds += 1; handshake.nextFullRetryAt = Infinity; setResponseRounds(handshake.responseRounds)
      } else if (handshake.state === 'WAITING_FOR_SENDER' && (handshake.fastReadyMac || handshake.readyMessage) && !alignmentSeen.current) {
        handshake.outgoing = rotateHandshakePackets(handshake.fastReadyMac
          ? fastReadyPackets(compactId, audioSequence.current, handshake.fastReadyMac)
          : fragmentHandshakeMessage(compactId, audioSequence.current, compactId, 2, handshake.readyMessage!), handshake.readyRounds)
        audioSequence.current = (audioSequence.current + handshake.outgoing.length) & 0xffff
        handshake.readyRounds += 1
      }
    }
    const pendingHandshakePacket = connectionMode === 'audio' ? handshake.outgoing.shift() : undefined
    if (pendingHandshakePacket) { type = pendingHandshakePacket.type; payload = pendingHandshakePacket.payload }
    else if (connectionMode === 'audio' && profile.colorMode === 'rgb' && handshake.state === 'WAITING_FOR_OFFER' && qualityFeedbackRef.current && qualityFeedbackRef.current.failures >= 3 && performance.now() >= qualityFeedbackRef.current.nextAt) {
      const feedback = qualityFeedbackRef.current
      transferId = feedback.transferId
      type = ControlType.OPTICAL_QUALITY
      payload = makeOpticalQualityPayload(opticalProfileNumber(profile), feedback.failures >= 12 ? 2 : 1)
      feedback.nextAt = performance.now() + 5000
    }
    else if (verified.current) { type = ControlType.TRANSFER_COMPLETE; payload = completionTagRef.current || new Uint8Array(); compact = connectionMode === 'audio' && !completionTagRef.current }
    else if (connectionMode === 'audio' && opticalLost.current) { type = ControlType.PAUSE; payload = Uint8Array.of(opticalProfileNumber(profile), (pacingCode.current << 4) | PROTOCOL_VERSION) }
    else if (connectionMode === 'audio' && resumeRepeats.current > 0) { type = ControlType.RESUME; payload = Uint8Array.of(opticalProfileNumber(profile), (pacingCode.current << 4) | PROTOCOL_VERSION); resumeRepeats.current -= 1 }
    else if (connectionMode === 'audio' && calibrationMode.current === 'selected') { type = ControlType.CALIBRATION_SELECTED; payload = Uint8Array.of(opticalProfileNumber(profile), PROTOCOL_VERSION, selectedPaceCode.current, 0); compact = true }
    else if (connectionMode === 'audio' && alignmentSeen.current && calibrationMode.current !== 'transferring') { type = ControlType.PROFILE_SELECTED; payload = Uint8Array.of(opticalProfileNumber(profile), (pacingCode.current << 4) | PROTOCOL_VERSION) }
    else if (connectionMode === 'audio' && !manifest && calibrationMode.current === 'transferring') { type = ControlType.BLOCK_STATUS; payload = makeCompactStatusPayload(0, 0, pacingCode.current); compact = true }
    else if (connectionMode === 'audio' && !manifest && handshake.state !== 'ESTABLISHED') return
    else if (connectionMode === 'audio' && !manifest) { type = ControlType.HELLO; payload = Uint8Array.of(diskStorageRef.current === 'opfs' || diskStorageRef.current === 'indexeddb' ? 1 : 0) }
    else if (!manifest) return
    else if (connectionMode === 'audio' && (handshake.responseCapabilities || 0) & HANDSHAKE_CAPABILITY_SPARSE_STREAM) {
      const now = performance.now(), completion = state.received.size / manifest.totalBlocks
      const interval = completion >= 0.98 ? 2000 : completion >= 0.9 ? 3000 : 6000
      if (completion >= 0.75 && now - lastHintAt.current >= interval) {
        const window = state.received.nextMissingWindow(hintCursor.current)
        if (window) { type = ControlType.MISSING_HINT; payload = makeMissingHintPayload(window.windowBase, window.missingMask, state.received.size); hintCursor.current = window.nextCursor; lastHintAt.current = now }
        else return
      } else if (now - lastPaceReportAt.current >= 2000) {
        type = ControlType.BLOCK_STATUS; payload = makeCompactStatusPayload(state.received.firstMissing(), 0, pacingCode.current); compact = true; lastPaceReportAt.current = now
      } else return
    }
    else {
      type = connectionMode === 'audio' && !readySent.current ? ControlType.READY : ControlType.BLOCK_STATUS
      let firstMissing = 0
      while (firstMissing < manifest.totalBlocks && state.received.has(firstMissing)) firstMissing += 1
      if (connectionMode === 'audio') {
        let bitmap = 0
        for (let bit = 0; bit < 4; bit += 1) if (state.received.has(firstMissing + bit)) bitmap |= 1 << bit
        payload = makeCompactStatusPayload(firstMissing, bitmap, pacingCode.current)
        compact = true
      } else {
        const base = Math.floor(Math.min(firstMissing, manifest.totalBlocks - 1) / 32) * 32
        let bitmap = 0
        for (let bit = 0; bit < 32; bit += 1) if (state.received.has(base + bit)) bitmap |= (1 << bit)
        payload = makeBlockStatusPayload(base, bitmap >>> 0)
      }
      if (type === ControlType.READY) readySent.current = true
    }
    const packet = pendingHandshakePacket || { type, transferId, sequence: audioSequence.current++ & 0xffff, payload }
    const responseFragment = pendingHandshakePacket?.type === ControlType.HANDSHAKE_DENSE_FRAGMENT || pendingHandshakePacket?.type === ControlType.HANDSHAKE_FRAGMENT && pendingHandshakePacket.payload[2] === 1
    const probePacket = pendingHandshakePacket?.type === ControlType.ACOUSTIC_PROBE
    const handshakeMode: AcousticToneCount = responseFragment ? responseToneCount(handshake.responseCapabilities || handshake.offer?.capabilities || 0, handshake.responseRounds) : handshake.audioMode || 2
    const toneCount: AcousticToneCount = probePacket ? pendingHandshakePacket!.payload[2] as AcousticToneCount : pendingHandshakePacket ? handshakeMode : type === ControlType.OPTICAL_QUALITY ? 8 : handshake.state === 'ESTABLISHED' ? handshake.audioMode || 2 : 2
    const octalSeconds = type === ControlType.OPTICAL_QUALITY ? undefined : octalSymbolSeconds(handshake.offer?.capabilities || 0, handshake.responseCapabilities || 0)
    const handshakeFragment = pendingHandshakePacket?.type === ControlType.HANDSHAKE_FRAGMENT || pendingHandshakePacket?.type === ControlType.HANDSHAKE_DENSE_FRAGMENT
    const samples = toneCount === 32 ? handshakeFragment ? encodeOfdmHandshakePacket(packet, context.sampleRate) : compact ? encodeOfdmCompactPacket(packet, context.sampleRate) : encodeOfdmPacket(packet, context.sampleRate)
      : toneCount === 16 ? handshakeFragment ? encodeHexFskHandshakePacket(packet, context.sampleRate) : compact ? encodeHexCompactFskPacket(packet, context.sampleRate) : encodeHexFskPacket(packet, context.sampleRate)
      : toneCount === 8 ? handshakeFragment ? encodeOctalFskHandshakePacket(packet, context.sampleRate, octalSeconds) : compact ? encodeOctalCompactFskPacket(packet, context.sampleRate, octalSeconds) : encodeOctalFskPacket(packet, context.sampleRate, octalSeconds)
      : toneCount === 4 ? handshakeFragment ? encodeQuadFskHandshakePacket(packet, context.sampleRate) : compact ? encodeQuadCompactFskPacket(packet, context.sampleRate) : encodeQuadFskPacket(packet, context.sampleRate)
        : compact ? encodeCompactFskPacket(packet, context.sampleRate) : encodeFskPacket(packet, context.sampleRate)
    const buffer = context.createBuffer(1, samples.length, context.sampleRate)
    buffer.copyToChannel(samples, 0)
    const source = context.createBufferSource(); source.buffer = buffer; source.connect(context.destination)
    const start = Math.max(context.currentTime, nextAudioStart.current)
    source.start(start)
    nextAudioStart.current = start + buffer.duration + (toneCount === 2 ? 0.1 : 0.015)
    if (connectionMode === 'audio' && (probePacket || handshakeFragment || type === ControlType.HANDSHAKE_COMPLETE)) handshake.acousticAirtimeSeconds = (handshake.acousticAirtimeSeconds || 0) + buffer.duration + (toneCount === 2 ? 0.1 : 0.015)
    setAudioPacketsSent(value => value + 1)
    const modeLabel = toneCount === 32 ? 'OFDM' : `${toneCount}-FSK`
    setSpeakerStatus(probePacket ? `Measuring acoustic channel · ${modeLabel} CRC probe (${handshake.outgoing.length} remaining)` : handshakeFragment ? `Sending ${modeLabel} ${packet.type === ControlType.HANDSHAKE_DENSE_FRAGMENT ? 'dense ' : ''}secure handshake fragment (${handshake.outgoing.length} remaining)` : type === ControlType.HANDSHAKE_COMPLETE ? `Sending ${modeLabel} authenticated READY (${handshake.outgoing.length} part remaining)` : type === ControlType.OPTICAL_QUALITY ? 'RGB header readable, payload failing CRC · asking sender to hold the offer longer' : type === ControlType.HELLO ? `Sending audio HELLO · session ${transferId.toString(16).padStart(8, '0')}` : type === ControlType.PROFILE_SELECTED ? 'Camera aligned · requesting optical calibration' : type === ControlType.CALIBRATION_SELECTED ? `Calibration selected ${opticalPaceFps(selectedPaceCode.current)} FPS · sending over sound` : type === ControlType.PAUSE ? 'Optical link lost · sending PAUSE over sound' : type === ControlType.RESUME ? 'Optical link reacquired · sending RESUME over sound' : type === ControlType.TRANSFER_COMPLETE ? 'Sending verified-complete tone' : type === ControlType.READY ? 'Optical manifest confirmed; sending compact READY' : compact ? `Sending ${modeLabel} compact cumulative block ACK` : 'Sending block bitmap over speaker')
    if (probePacket && !handshake.outgoing.length) { handshake.state = 'WAITING_FOR_MODE_SELECTION'; setHandshakeState('WAITING_FOR_MODE_SELECTION') }
    if (responseFragment && pendingHandshakePacket && !handshake.outgoing.length) {
      handshake.nextFullRetryAt = performance.now() + Math.ceil((nextAudioStart.current - context.currentTime) * 1000) + 5000
    }
    if (pendingHandshakePacket && !handshake.outgoing.length && handshake.state === 'SENDING_READY') {
      setSpeakerStatus(`Final ${toneCount}-tone READY queued; waiting for playback to finish…`)
      readyPlaybackTimer.current = window.setTimeout(() => {
        readyPlaybackTimer.current = null
        if (handshakeRef.current !== handshake || handshake.state !== 'SENDING_READY') return
        handshake.state = 'WAITING_FOR_SENDER'; setHandshakeState('WAITING_FOR_SENDER')
        setSpeakerStatus('Authenticated READY played; repeating until the sender switches to optical data…')
        setFileStatus('Waiting for sender to receive READY and display the paired optical alignment frame…')
      }, Math.ceil((nextAudioStart.current - context.currentTime) * 1000))
    }
    if (type === ControlType.TRANSFER_COMPLETE && ++completeSignalsSent.current >= 3) {
      if (speakerTimer.current !== null) window.clearInterval(speakerTimer.current)
      speakerTimer.current = null
      completionStopTimer.current = window.setTimeout(() => { stopSpeaker(); setSpeakerStatus('Verified completion sent · speaker off') }, Math.ceil((nextAudioStart.current - context.currentTime) * 1000) + 150)
    }
  }
  const startSpeaker = async () => {
    if (speaker.current) return
    try { const context = new AudioContext(); speaker.current = context; await context.resume(); setSpeakerStatus(connectionMode === 'audio' ? 'Speaker ready; waiting for the sender optical offer' : 'Speaker ready; awaiting recovered blocks'); sendAcousticStatus(); speakerTimer.current = window.setInterval(sendAcousticStatus, connectionMode === 'audio' && handshakeRef.current.offer?.capabilities && (handshakeRef.current.offer.capabilities & (HANDSHAKE_CAPABILITY_OCTAL_FSK | HANDSHAKE_CAPABILITY_QUAD_FSK)) ? 150 : connectionMode === 'audio' ? 2200 : 4400) }
    catch { stopSpeaker(); setSpeakerStatus('Could not start speaker feedback') }
  }
  useEffect(() => {
    if (!speaker.current || connectionMode !== 'audio') return
    if (speakerTimer.current !== null) window.clearInterval(speakerTimer.current)
    const fast = handshakeState === 'ESTABLISHED' ? (handshakeRef.current.audioMode || 2) > 2 : !!(handshakeRef.current.offer?.capabilities && (handshakeRef.current.offer.capabilities & (HANDSHAKE_CAPABILITY_OCTAL_FSK | HANDSHAKE_CAPABILITY_QUAD_FSK))) && handshakeState !== 'CANCELLED' && handshakeState !== 'FAILED'
    speakerTimer.current = window.setInterval(sendAcousticStatus, fast ? 150 : 2200)
    return () => { if (speakerTimer.current !== null) window.clearInterval(speakerTimer.current); speakerTimer.current = null }
  }, [connectionMode, handshakeState])
  useEffect(() => {
    if (task !== 'file' || connectionMode !== 'audio' || !cameraActive) return
    const timer = window.setInterval(() => {
      if (!speaker.current || !alignmentSeen.current || !lastOpticalAt.current || opticalLost.current || verified.current) return
      // A slow camera can decode the first probe and miss every faster stage.
      // Keep waiting for the deliberately slow end marker before declaring
      // the link lost; otherwise calibration loops before selecting 1–2 FPS.
      const calibrating = calibrationMode.current === 'probing' || calibrationMode.current === 'selected'
      const lossTimeoutMs = calibrating ? Math.max(12000, calibrationRates(profile).length * CALIBRATION_STAGE_MS + 6000) : 12000
      if (performance.now() - lastOpticalAt.current < lossTimeoutMs) return
      opticalLost.current = true; resumeRepeats.current = 0; setOpticalLink('interrupted')
      setFileStatus('Optical link interrupted. Re-align the camera; incomplete blocks remain available for repair.')
      sendAcousticStatus()
    }, 1000)
    return () => window.clearInterval(timer)
  }, [task, connectionMode, cameraActive, profile, audioSessionId])
  const resetFile = () => { cancelHandshake(); handshakeRef.current = { state: 'WAITING_FOR_OFFER', responseRounds: 0, readyRounds: 0, outgoing: [], reassembler: new AcousticFragmentReassembler() }; setHandshakeState('WAITING_FOR_OFFER'); setResponseRounds(0); sasManuallyVerifiedRef.current = false; stopSpeaker(); void fileState.current.sink?.remove(); fileState.current = emptyFileState(); fileDecodeStats.current = { symbols: 0, usefulShards: 0, usefulShardBytes: 0, recoveredBlocks: 0, invalidSymbols: 0, sessionRejects: 0, manifestShards: 0, lastBlock: -1 }; completionTagRef.current = null; lastPaceReportAt.current = 0; lastHintAt.current = 0; hintCursor.current = 0; duplicateBlocks.current = 0; wastedFrames.current = 0; verified.current = false; readySent.current = false; alignmentSeen.current = false; opticalLost.current = false; lastOpticalAt.current = 0; resumeRepeats.current = 0; pacingCode.current = 0; selectedPaceCode.current = 0; calibrationMode.current = 'idle'; calibrationSamples.current.clear(); setRecommendedPace(0); setOpticalLink('searching'); completeSignalsSent.current = 0; fileStarted.current = 0; const nextSessionId = crypto.getRandomValues(new Uint32Array(1))[0]; audioSessionIdRef.current = nextSessionId; setAudioSessionId(nextSessionId); setCameraActive(true); setFileProgress({ blocks: 0, totalBlocks: 0, receivedBytes: 0, totalBytes: 0, verifiedBytes: 0, elapsedSeconds: 0 }); if (downloadUrl) URL.revokeObjectURL(downloadUrl); setDownloadUrl(null); setFileStatus('Waiting for secure optical handshake offer') }
  const markStored = (state: FileReceiveState, blockId: number) => {
    if (fileState.current !== state || state.received.has(blockId)) return
    const manifest = state.manifest
    if (!manifest) return
    state.received.add(blockId)
    const blockLength = Math.min(manifest.blockBytes, TRANSFER_MANIFEST_BYTES + manifest.archiveBytes - blockId * manifest.blockBytes)
    state.receivedBytes += Math.max(0, blockLength - (blockId === 0 ? TRANSFER_MANIFEST_BYTES : 0))
    setFileStatus(`Stored ${state.received.size} of ${manifest.totalBlocks} blocks · transfer ${state.id!.toString(16).padStart(8, '0')}`)
    setFileProgress(previous => ({ ...previous, blocks: state.received.size, totalBlocks: manifest.totalBlocks, receivedBytes: state.receivedBytes, totalBytes: manifest.archiveBytes, elapsedSeconds: fileStarted.current ? (performance.now() - fileStarted.current) / 1000 : 0 }))
    if (!((handshakeRef.current.responseCapabilities || 0) & HANDSHAKE_CAPABILITY_SPARSE_STREAM)) sendAcousticStatus()
    finishFileIfReady(state)
  }
  const queueBlockWrite = (state: FileReceiveState, blockId: number, bytes: Uint8Array) => {
    if (!state.sink) return
    void state.sink.writeBlock(blockId, bytes).then(() => { state.blocks.delete(blockId); markStored(state, blockId) }).catch(error => { state.storageError = true; setFileStatus(error instanceof Error ? error.message : 'Could not write local optical block') })
  }
  const finishFileIfReady = (state: FileReceiveState) => {
    const manifest = state.manifest
    if (!manifest || state.received.size < manifest.totalBlocks || state.sinkOpening || state.storageError || state.verifying) return
    state.verifying = true
    const verificationStarted = performance.now()
    setFileStatus('All optical blocks stored. Checking local SHA-256…')
    void (async () => {
      let archive: Blob
      if (state.sink) archive = await state.sink.finish()
      else {
        const bytes = new Uint8Array(manifest.archiveBytes)
        let cursor = 0
        for (let index = 0; index < manifest.totalBlocks; index += 1) {
          const recovered = state.blocks.get(index)
          if (!recovered) throw new Error('Missing reconstructed optical block')
          const payload = index === 0 ? recovered.subarray(TRANSFER_MANIFEST_BYTES) : recovered
          bytes.set(payload, cursor); cursor += payload.length
        }
        if (cursor !== bytes.length) throw new Error('Archive length mismatch')
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.buffer as ArrayBuffer))
        if (!digest.every((value, index) => value === manifest.sha256[index])) throw new Error('SHA-256 mismatch; transfer not verified')
        archive = new Blob([bytes], { type: 'application/zip' })
      }
      if (fileState.current !== state) return
      setDownloadUrl(URL.createObjectURL(archive))
      const material = handshakeRef.current.material
      if (connectionMode === 'audio' && (handshakeRef.current.responseCapabilities || 0) & HANDSHAKE_CAPABILITY_SPARSE_STREAM && material) completionTagRef.current = transferCompletionTag(material.keys.handshakeConfirmKey, material.transcriptHash, manifest.sha256, manifest.totalBlocks)
      verified.current = true
      handshakeRef.current.privateKey?.fill(0); handshakeRef.current.material?.keys.opticalEncryptionKey.fill(0); handshakeRef.current.material?.keys.handshakeConfirmKey.fill(0); handshakeRef.current.material?.keys.sessionBindingKey.fill(0)
      setCameraActive(false)
      const grid = gridRef.current
      grid?.getContext('2d')?.clearRect(0, 0, grid.width, grid.height)
      sendAcousticStatus()
      setFileProgress(previous => ({ ...previous, verifiedBytes: archive.size, elapsedSeconds: fileStarted.current ? (performance.now() - fileStarted.current) / 1000 : 0 }))
      setFileStatus(`TRANSFER VERIFIED · ${archive.size.toLocaleString()} ZIP bytes · SHA-256 checked in ${((performance.now() - verificationStarted) / 1000).toFixed(1)} s`)
    })().catch(error => { if (fileState.current === state) setFileStatus(error instanceof Error ? error.message : 'Could not verify optical archive') })
  }
  const acceptSas = (manuallyVerified = false) => {
    const handshake = handshakeRef.current
    if (handshake.state !== 'AWAITING_USER_VERIFICATION') return
    sasManuallyVerifiedRef.current = manuallyVerified
    handshake.state = 'WAITING_FOR_KEY_CONFIRM'; setHandshakeState('WAITING_FOR_KEY_CONFIRM'); setSpeakerStatus('Pairing code accepted; waiting for sender key confirmation…')
  }
  useEffect(() => {
    if (connectionMode !== 'audio' || !handsFreePairing || handshakeState !== 'AWAITING_USER_VERIFICATION') return
    setVerificationSeconds(3)
    const countdown = window.setInterval(() => setVerificationSeconds(value => Math.max(0, value - 1)), 1000)
    const confirm = window.setTimeout(() => acceptSas(false), 3000)
    return () => { window.clearInterval(countdown); window.clearTimeout(confirm) }
  }, [connectionMode, handsFreePairing, handshakeState])
  const cancelHandshake = () => {
    const handshake = handshakeRef.current
    qualityFeedbackRef.current = null
    if (readyPlaybackTimer.current !== null) window.clearTimeout(readyPlaybackTimer.current); readyPlaybackTimer.current = null
    handshake.privateKey?.fill(0); handshake.material?.keys.opticalEncryptionKey.fill(0); handshake.material?.keys.handshakeConfirmKey.fill(0); handshake.material?.keys.sessionBindingKey.fill(0); handshake.reassembler.clear()
    handshakeRef.current = { state: 'CANCELLED', responseRounds: 0, readyRounds: 0, outgoing: [], reassembler: new AcousticFragmentReassembler() }; sasManuallyVerifiedRef.current = false; setHandshakeState('CANCELLED'); setResponseRounds(0); setSas(null); setSpeakerStatus('Secure pairing cancelled')
  }
  const prepareAcousticResponse = (mode?: 8 | 16 | 32) => {
    const handshake = handshakeRef.current, offer = handshake.offer
    if (!offer || !handshake.privateKey || !handshake.publicKey) return
    const compactId = new DataView(offer.sessionId.buffer, offer.sessionId.byteOffset, 4).getUint32(0)
    let responseCapabilities = offer.capabilities & (HANDSHAKE_CAPABILITY_QUAD_FSK | HANDSHAKE_CAPABILITY_QUAD_CONTROL | HANDSHAKE_CAPABILITY_OCTAL_FSK | HANDSHAKE_CAPABILITY_OCTAL_CONTROL | HANDSHAKE_CAPABILITY_COMPACT_READY | HANDSHAKE_CAPABILITY_FAST_READY | HANDSHAKE_CAPABILITY_FAST_OCTAL | HANDSHAKE_CAPABILITY_DENSE_RESPONSE | HANDSHAKE_CAPABILITY_RESPONSE_PARITY | HANDSHAKE_CAPABILITY_ADAPTIVE_AUDIO | HANDSHAKE_CAPABILITY_HEX_FSK | HANDSHAKE_CAPABILITY_OFDM | HANDSHAKE_CAPABILITY_SPARSE_STREAM)
    if (!sparseStorageAvailable.current) responseCapabilities &= ~HANDSHAKE_CAPABILITY_SPARSE_STREAM
    if (!mode) responseCapabilities &= ~(HANDSHAKE_CAPABILITY_ADAPTIVE_AUDIO | HANDSHAKE_CAPABILITY_HEX_FSK | HANDSHAKE_CAPABILITY_OFDM)
    else if (mode === 8) responseCapabilities &= ~(HANDSHAKE_CAPABILITY_HEX_FSK | HANDSHAKE_CAPABILITY_OFDM | HANDSHAKE_CAPABILITY_FAST_OCTAL)
    else if (mode === 16) responseCapabilities &= ~HANDSHAKE_CAPABILITY_OFDM
    else if (!(responseCapabilities & HANDSHAKE_CAPABILITY_OFDM)) throw new Error('OFDM was not offered')
    if (mode === 16 && (!(responseCapabilities & HANDSHAKE_CAPABILITY_ADAPTIVE_AUDIO) || !(responseCapabilities & HANDSHAKE_CAPABILITY_HEX_FSK))) throw new Error('16-FSK was not offered')
    if (!(responseCapabilities & HANDSHAKE_CAPABILITY_DENSE_RESPONSE) || !wasmBytes.current) responseCapabilities &= ~HANDSHAKE_CAPABILITY_RESPONSE_PARITY
    const response = makeResponse(offer, { privateKey: handshake.privateKey, publicKey: handshake.publicKey }, opticalProfileNumber(profile), responseCapabilities)
    handshake.state = 'GENERATING_RESPONSE'; setHandshakeState('GENERATING_RESPONSE')
    handshake.responseCapabilities = response.capabilities; handshake.selectedMode = mode; handshake.material = deriveHandshakeMaterial(offer, response, handshake.privateKey, 'receiver')
    handshake.responseMessage = encodeHandshakeResponse(response)
    handshake.responsePackets = responseCapabilities & HANDSHAKE_CAPABILITY_DENSE_RESPONSE
      ? fragmentDenseHandshakeResponse(compactId, audioSequence.current, offer.sessionId, handshake.responseMessage, responseCapabilities & HANDSHAKE_CAPABILITY_RESPONSE_PARITY ? new ReedSolomonBlockCodec(ReedSolomonErasure.fromBytes(new Uint8Array(wasmBytes.current!).buffer)) : undefined)
      : fragmentHandshakeMessage(compactId, audioSequence.current, compactId, 1, handshake.responseMessage)
    handshake.outgoing = handshake.responsePackets.slice(); audioSequence.current = (audioSequence.current + handshake.outgoing.length) & 0xffff
    handshake.responseRounds = 1; handshake.nextFullRetryAt = Infinity; handshake.lastNackRequestId = undefined; handshake.lastNackAt = undefined; handshake.selectivePackets = 0; setResponseRounds(1)
    handshake.state = 'AWAITING_USER_VERIFICATION'; setHandshakeState('AWAITING_USER_VERIFICATION'); setSas(handshake.material.sas)
    setFileStatus(speaker.current ? `Sender detected. Sending ${mode === 32 ? 'OFDM' : `${mode || responseToneCount(offer.capabilities, 1)}-FSK`} secure response; verify the pairing code.` : 'Sender detected. Enable receiver speaker to send the audio response; then verify the pairing code.')
    sendAcousticStatus()
  }
  const receiveHandshakeFrame = (payload: Uint8Array) => {
    const handshake = handshakeRef.current
    const nack = decodeHandshakeNack(payload)
    if (nack && connectionMode === 'audio') {
      if (handshake.offer && handshake.responsePackets && (handshake.state === 'AWAITING_USER_VERIFICATION' || handshake.state === 'WAITING_FOR_KEY_CONFIRM') && isFreshHandshakeNackRequest(nack.requestId, handshake.lastNackRequestId, performance.now(), handshake.lastNackAt)) {
        const selected = selectHandshakeNackRetransmissions(nack, handshake.offer.sessionId, handshake.responsePackets, audioSequence.current)
        if (selected.length) {
          audioSequence.current = (audioSequence.current + selected.length) & 0xffff
          // Prioritize repair without dropping response packets already queued.
          handshake.outgoing = selected.concat(handshake.outgoing)
          handshake.lastNackRequestId = nack.requestId; handshake.lastNackAt = performance.now()
          handshake.selectivePackets = (handshake.selectivePackets || 0) + selected.length
          handshake.nextFullRetryAt = Infinity
          setSpeakerStatus(`Optical repair request received · replaying only ${selected.length} missing audio fragment${selected.length === 1 ? '' : 's'}`)
          sendAcousticStatus()
        }
      }
      return true
    }
    const selection = decodeAudioModeSelect(payload)
    if (selection && connectionMode === 'audio') {
      if (handshake.state === 'PROBING_CHANNEL' || handshake.state === 'WAITING_FOR_MODE_SELECTION') {
        if (handshake.offer && equalBytes(selection.sessionId, handshake.offer.sessionId) && (handshake.offer.capabilities & HANDSHAKE_CAPABILITY_ADAPTIVE_AUDIO) && (selection.mode === 8 || selection.mode === 16 && !!(handshake.offer.capabilities & HANDSHAKE_CAPABILITY_HEX_FSK) || selection.mode === 32 && !!(handshake.offer.capabilities & HANDSHAKE_CAPABILITY_OFDM))) {
          try { prepareAcousticResponse(selection.mode) }
          catch { handshake.privateKey?.fill(0); handshake.outgoing = []; handshake.state = 'FAILED'; setHandshakeState('FAILED'); setFileStatus('Invalid acoustic mode selection') }
        }
      }
      return true
    }
    const offer = decodeHandshakeOffer(payload)
    if (offer && handshake.offer && !equalBytes(offer.sessionId, handshake.offer.sessionId) && (handshake.state === 'PROBING_CHANNEL' || handshake.state === 'WAITING_FOR_MODE_SELECTION' || handshake.state === 'AWAITING_USER_VERIFICATION' || handshake.state === 'WAITING_FOR_KEY_CONFIRM')) {
      handshake.privateKey?.fill(0); handshake.material?.keys.opticalEncryptionKey.fill(0); handshake.material?.keys.handshakeConfirmKey.fill(0); handshake.material?.keys.sessionBindingKey.fill(0)
      handshakeRef.current = { state: 'WAITING_FOR_OFFER', responseRounds: 0, readyRounds: 0, outgoing: [], reassembler: new AcousticFragmentReassembler() }
      setSas(null); setResponseRounds(0); setHandshakeState('WAITING_FOR_OFFER')
      return receiveHandshakeFrame(payload)
    }
    if (offer && connectionMode === 'audio' && (handshake.state === 'WAITING_FOR_OFFER' || handshake.state === 'CANCELLED')) {
      if (!sparseStorageProbeDone.current) return true
      try {
        qualityFeedbackRef.current = null
        const compactId = new DataView(offer.sessionId.buffer, offer.sessionId.byteOffset, 4).getUint32(0), receiver = generateEphemeralKeyPair()
        handshake.offer = offer; handshake.privateKey = receiver.privateKey; handshake.publicKey = receiver.publicKey; handshake.acousticAirtimeSeconds = 0; audioSessionIdRef.current = compactId; setAudioSessionId(compactId)
        if ((offer.capabilities & (HANDSHAKE_CAPABILITY_ADAPTIVE_AUDIO | HANDSHAKE_CAPABILITY_HEX_FSK)) === (HANDSHAKE_CAPABILITY_ADAPTIVE_AUDIO | HANDSHAKE_CAPABILITY_HEX_FSK)) {
          const tag = denseHandshakeSessionTag(offer.sessionId)
          handshake.outgoing = (offer.capabilities & HANDSHAKE_CAPABILITY_OFDM ? [8, 16, 32] : [8, 16]).map((mode, index) => ({ type: ControlType.ACOUSTIC_PROBE, transferId: compactId, sequence: (audioSequence.current + index) & 0xffff, payload: Uint8Array.of(tag, index, mode) }))
          audioSequence.current = (audioSequence.current + handshake.outgoing.length) & 0xffff
          handshake.state = 'PROBING_CHANNEL'; setHandshakeState('PROBING_CHANNEL'); setFileStatus(`Sender detected. Measuring the acoustic path with 8-FSK, 16-FSK${offer.capabilities & HANDSHAKE_CAPABILITY_OFDM ? ', and OFDM' : ''} probes…`); sendAcousticStatus()
        } else prepareAcousticResponse()
      } catch { handshake.privateKey?.fill(0); handshake.outgoing = []; handshake.state = 'FAILED'; setHandshakeState('FAILED'); setFileStatus('Invalid optical handshake offer') }
      return true
    }
    const confirm = decodeKeyConfirm(payload)
    const confirmedMode: AcousticToneCount = confirm?.toneCount || (handshake.offer?.capabilities && (handshake.offer.capabilities & HANDSHAKE_CAPABILITY_QUAD_CONTROL) ? 4 : 2)
    const modeAllowed = runtimeToneAllowed(handshake.responseCapabilities || handshake.offer?.capabilities || 0, confirmedMode)
    if (confirm && connectionMode === 'audio' && handshake.state === 'WAITING_FOR_KEY_CONFIRM' && handshake.offer && handshake.material && modeAllowed && equalBytes(confirm.sessionId, handshake.offer.sessionId) && equalBytes(confirm.confirmation, confirm.toneCount ? keyConfirmAudioMode(handshake.material.keys.handshakeConfirmKey, handshake.material.transcriptHash, confirm.toneCount) : keyConfirm(handshake.material.keys.handshakeConfirmKey, handshake.material.transcriptHash))) {
      handshake.audioMode = confirmedMode
      const compactId = new DataView(handshake.offer.sessionId.buffer, handshake.offer.sessionId.byteOffset, 4).getUint32(0)
      const fastReady = (confirmedMode === 8 || confirmedMode === 16 || confirmedMode === 32) && fastReadyNegotiated(handshake.offer.capabilities, handshake.responseCapabilities || 0)
      handshake.fastReadyMac = fastReady ? readyConfirmFast(handshake.material.keys.handshakeConfirmKey, handshake.material.transcriptHash) : undefined
      handshake.readyMessage = fastReady ? undefined : (confirmedMode === 8 || confirmedMode === 16 || confirmedMode === 32) && compactReadyNegotiated(handshake.offer.capabilities, handshake.responseCapabilities || 0)
        ? encodeReadyConfirmCompact(handshake.offer.sessionId, readyConfirmCompact(handshake.material.keys.handshakeConfirmKey, handshake.material.transcriptHash))
        : encodeReadyConfirm(handshake.offer.sessionId, readyConfirm(handshake.material.keys.handshakeConfirmKey, handshake.material.transcriptHash))
      handshake.outgoing = fastReady
        ? fastReadyPackets(compactId, audioSequence.current, handshake.fastReadyMac!)
        : fragmentHandshakeMessage(compactId, audioSequence.current, compactId, 2, handshake.readyMessage!)
      audioSequence.current = (audioSequence.current + handshake.outgoing.length) & 0xffff
      handshake.readyRounds = 1; handshake.responseMessage = undefined; handshake.responsePackets = undefined; handshake.nextFullRetryAt = undefined
      handshake.state = 'SENDING_READY'; setHandshakeState('SENDING_READY'); setFileStatus(`Sender key confirmed. Sending ${confirmedMode === 32 ? 'OFDM' : `${confirmedMode}-tone`} receiver confirmation…`); sendAcousticStatus()
      return true
    }
    if (confirm && connectionMode === 'audio' && handshake.state === 'WAITING_FOR_KEY_CONFIRM') {
      setFileStatus('Optical key confirmation rejected: session, audio mode, or authentication mismatch')
      return true
    }
    // Repeated optical key-confirmation frames remain handshake traffic after
    // our READY plays; they are not malformed file symbols.
    if (confirm && handshake.offer && equalBytes(confirm.sessionId, handshake.offer.sessionId)) return true
    return false
  }
  const acceptFileFrame = async (result: OpticalImageDecode) => {
    if (!recoveryCodec.current || !result.ok) return
    if (connectionMode === 'audio' && receiveHandshakeFrame(result.payload)) return
    if (connectionMode === 'audio' && handshakeRef.current.state !== 'WAITING_FOR_SENDER' && handshakeRef.current.state !== 'ESTABLISHED') return
    const symbol = unpackOpticalSymbol(result.payload)
    if (!symbol || symbol.blockId !== result.header.blockId) { fileDecodeStats.current.invalidSymbols += 1; return }
    const state = fileState.current
    if (connectionMode === 'audio' && symbol.transferId !== audioSessionId) { fileDecodeStats.current.sessionRejects += 1; return }
    if (connectionMode === 'audio' && (result.header.profileId !== opticalProfileNumber(profile) || result.header.version !== PROTOCOL_VERSION)) { fileDecodeStats.current.invalidSymbols += 1; return }
    if (connectionMode === 'audio' && !alignmentSeen.current) {
      // A correctly routed file symbol proves the sender received READY.
      // Stop replaying it immediately instead of waiting for block-zero FEC.
      handshakeRef.current.fastReadyMac = undefined; handshakeRef.current.readyMessage = undefined; handshakeRef.current.outgoing = []
      handshakeRef.current.state = 'ESTABLISHED'; setHandshakeState('ESTABLISHED')
      setFileStatus('Sender received READY. Paired optical alignment detected; collecting encrypted manifest shards…')
    }
    if (connectionMode === 'audio') {
      const calibration = readCalibrationFrameId(result.header.frameId)
      if (opticalLost.current && !calibration && result.header.frameId === 0 && calibrationMode.current !== 'transferring') { calibrationMode.current = 'idle'; selectedPaceCode.current = 0; calibrationSamples.current.clear() }
      if (calibration?.stage === CALIBRATION_END_STAGE && calibrationMode.current !== 'selected' && calibrationMode.current !== 'transferring') {
        const samples = new Map<number, { firstSequence: number; lastSequence: number; uniqueFrames: number; distinctShards: number; spanMs: number; recoverableVisits: number }>()
        for (const [stage, item] of calibrationSamples.current) samples.set(stage, { firstSequence: item.firstSequence, lastSequence: item.lastSequence, uniqueFrames: item.seen.size, distinctShards: item.shards.size, spanMs: item.lastAt - item.firstAt, recoverableVisits: countRecoverableCalibrationVisits(item.seen) })
        const code = selectCalibratedPaceCode(profile, samples)
        selectedPaceCode.current = code; pacingCode.current = code; adaptivePace.current = new AdaptiveOpticalPace(profile, code); setRecommendedPace(opticalPaceFps(code))
        calibrationMode.current = 'selected'
        setFileStatus(`Optical calibration complete: ${opticalPaceFps(code)} logical FPS. Sending selection over sound…`)
      } else if (calibration && calibration.stage < calibrationRates(profile).length && calibrationMode.current !== 'selected' && calibrationMode.current !== 'transferring') {
        calibrationMode.current = 'probing'
        const now = performance.now()
        let sample = calibrationSamples.current.get(calibration.stage)
        if (!sample) { sample = { firstSequence: calibration.sequence, lastSequence: calibration.sequence, seen: new Set<number>(), shards: new Set<number>(), firstAt: now, lastAt: now }; calibrationSamples.current.set(calibration.stage, sample) }
        sample.shards.add(symbol.index)
        if (!sample.seen.has(calibration.sequence)) { sample.seen.add(calibration.sequence); sample.firstSequence = Math.min(sample.firstSequence, calibration.sequence); sample.lastSequence = Math.max(sample.lastSequence, calibration.sequence); sample.lastAt = now }
      } else if (!calibration && result.header.frameId > 0) calibrationMode.current = 'transferring'
      lastOpticalAt.current = performance.now()
      if (!alignmentSeen.current) { alignmentSeen.current = true; setOpticalLink('aligned'); sendAcousticStatus() }
      else if (opticalLost.current) { opticalLost.current = false; resumeRepeats.current = 1; setOpticalLink('aligned'); setFileStatus(calibrationMode.current === 'transferring' ? 'Optical link reacquired. Receiving encrypted blocks…' : 'Optical link reacquired. Resuming calibration…'); sendAcousticStatus() }
      else if (calibrationMode.current === 'selected') sendAcousticStatus()
    }
    fileDecodeStats.current.symbols += 1
    fileDecodeStats.current.lastBlock = symbol.blockId
    if (state.id === null) state.id = symbol.transferId
    if (!fileStarted.current && result.header.frameId > 0 && !readCalibrationFrameId(result.header.frameId)) fileStarted.current = performance.now()
    if (symbol.transferId !== state.id || state.verifying || state.storageError) return
    if (state.received.has(symbol.blockId) || state.blocks.has(symbol.blockId)) { duplicateBlocks.current += 1; wastedFrames.current += 1; return }
    const cyclic = connectionMode === 'audio' && !!((handshakeRef.current.responseCapabilities || 0) & HANDSHAKE_CAPABILITY_SPARSE_STREAM)
    if (cyclic !== (symbol.visit !== undefined)) { fileDecodeStats.current.invalidSymbols += 1; return }
    if (state.manifest && symbol.blockId >= state.manifest.totalBlocks) return
    const collectorKey = `${symbol.blockId}:${symbol.visit ?? 'legacy'}`
    let collector = state.collectors.get(collectorKey)
    if (!collector) {
      if (state.collectors.size >= 64) state.collectors.delete(state.collectors.keys().next().value!)
      collector = new OpticalBlockCollector(recoveryCodec.current, symbol.transferId, symbol.blockId, symbol.visit); state.collectors.set(collectorKey, collector)
    }
    const previousShardCount = collector.count
    let block = collector.add(symbol)
    if (collector.count > previousShardCount) { fileDecodeStats.current.usefulShards += 1; fileDecodeStats.current.usefulShardBytes += symbol.bytes.length }
    else wastedFrames.current += 1
    if (symbol.blockId === 0) fileDecodeStats.current.manifestShards = collector.count
    if (!block) return
    if (connectionMode === 'audio') {
      const handshake = handshakeRef.current
      if (!handshake.offer || !handshake.material) return
      try { block = await aesGcmDecrypt(handshake.material.keys.opticalEncryptionKey, cyclic ? cyclicOpticalNonce(handshake.material.keys.sessionBindingKey.slice(0, 4), symbol.blockId, symbol.visit!) : opticalNonce(handshake.material.keys.sessionBindingKey.slice(0, 6), symbol.blockId, 0), block, cyclic ? cyclicOpticalBlockAad(handshake.offer.sessionId, symbol.transferId, symbol.blockId, symbol.visit!) : opticalBlockAad(handshake.offer.sessionId, symbol.transferId, symbol.blockId)); handshake.readyMessage = undefined; handshake.outgoing = [] }
      catch { state.collectors.delete(collectorKey); wastedFrames.current += collector.count; setFileStatus('Encrypted optical visit failed authentication; continuing cyclic repair'); return }
    }
    fileDecodeStats.current.recoveredBlocks += 1
    state.blocks.set(symbol.blockId, block); for (const key of state.collectors.keys()) if (key.startsWith(`${symbol.blockId}:`)) state.collectors.delete(key)
    if (symbol.blockId === 0) {
      const manifest = unpackTransferManifest(block)
      if (!manifest || manifest.transferId !== state.id) { state.storageError = true; setFileStatus('Invalid optical manifest'); return }
      state.manifest = manifest
      state.received.configure(manifest.totalBlocks)
      for (const [pendingId, pendingBytes] of state.blocks) {
        const expected = Math.min(manifest.blockBytes, TRANSFER_MANIFEST_BYTES + manifest.archiveBytes - pendingId * manifest.blockBytes)
        if (pendingId >= manifest.totalBlocks || pendingBytes.length !== expected) state.blocks.delete(pendingId)
      }
      setFileProgress(previous => ({ ...previous, totalBlocks: manifest.totalBlocks, totalBytes: manifest.archiveBytes }))
      state.sinkOpening = true
      void (async (): Promise<OpticalSink> => {
        if (diskStorageRef.current === 'opfs' && !cyclic) {
          try { return await LocalOpticalSink.create(manifest) }
          catch { /* Retry using local IndexedDB storage. */ }
        }
        return IndexedDbOpticalSink.create(manifest)
      })().then(sink => {
        if (fileState.current !== state) { void sink.remove(); return }
        state.sink = sink; state.sinkOpening = false
        for (const [index, bytes] of state.blocks) queueBlockWrite(state, index, bytes)
        finishFileIfReady(state)
      }).catch(error => {
        if (fileState.current !== state) return
        state.sinkOpening = false
        if (cyclic) { state.storageError = true; setFileStatus(`Sparse transfer requires durable IndexedDB storage: ${error instanceof Error ? error.message : 'storage error'}`); return }
        if (manifest.archiveBytes > 16 * 1024 * 1024) { state.storageError = true; setFileStatus(`Local browser storage unavailable: ${error instanceof Error ? error.message : 'storage error'}`); return }
        setFileStatus('Local browser storage unavailable; using 16 MiB memory fallback')
        for (const index of state.blocks.keys()) markStored(state, index)
        finishFileIfReady(state)
      })
    }
    if (state.sink) queueBlockWrite(state, symbol.blockId, block)
    else if (!state.sinkOpening && state.manifest) markStored(state, symbol.blockId)
    else if (state.blocks.size > (state.manifest ? 64 : 32)) {
      const oldest = state.blocks.keys().next().value!
      state.blocks.delete(oldest)
    }
  }
  useEffect(() => {
    const video = videoRef.current
    if (!video || !cameraActive) return
    let cancelled = false, stream: MediaStream | undefined, animation = 0, videoCallback: number | null = null, busy = false, lastCapture = 0
    const cameraFrames = new CameraFrameMeter()
    const worker = new Worker(new URL('./optical-worker.ts', import.meta.url), { type: 'module' })
    workerRef.current = worker
    const history: Array<{ at: number; bytes: number; valid: boolean; frameId: number | null; shards: number; shardBytes: number; recoveredBlocks: number; storedBytes: number }> = []
    const seen = new Set<number>()
    let valid = 0, failed = 0, processed = 0, lastUi = 0, adaptiveHistoryActive = false
    worker.onmessage = (event: MessageEvent<{ result: OpticalImageDecode; finderStage: string; decodeMs: number; acquireMs: number; drawMs: number; readMs: number; sampleMs: number; crcMs: number; pixelPath: string; gpuDiagnostic: string; temporalRecoveries: number; temporalCandidates: number }>) => {
      busy = false
      const now = performance.now(), result = event.data.result
      processed += 1
      if (task === 'file' && connectionMode === 'audio' && profile.colorMode === 'rgb' && handshakeRef.current.state === 'WAITING_FOR_OFFER' && !result.ok && result.reason === 'payload-crc' && result.header?.profileId === opticalProfileNumber(profile) && (result.header.frameId >>> 24) === (RGB_BOOTSTRAP_FRAME_TAG >>> 24)) {
        const current = qualityFeedbackRef.current
        qualityFeedbackRef.current = current?.transferId === result.header.blockId ? { ...current, failures: Math.min(255, current.failures + 1) } : { transferId: result.header.blockId, failures: 1, nextAt: 0 }
        if (qualityFeedbackRef.current.failures === 3) sendAcousticStatus()
      }
      if (task === 'file') void acceptFileFrame(result)
      const transferring = task === 'file' && connectionMode === 'audio' && calibrationMode.current === 'transferring'
      if (transferring !== adaptiveHistoryActive) { history.length = 0; adaptiveHistoryActive = transferring }
      if (result.ok) valid += 1; else failed += 1
      let uniqueBytes = 0
      if (result.ok && !seen.has(result.header.frameId)) { seen.add(result.header.frameId); uniqueBytes = result.payload.length }
      history.push({ at: now, bytes: uniqueBytes, valid: result.ok, frameId: result.ok ? result.header.frameId : null, shards: fileDecodeStats.current.usefulShards, shardBytes: fileDecodeStats.current.usefulShardBytes, recoveredBlocks: fileDecodeStats.current.recoveredBlocks, storedBytes: fileState.current.receivedBytes })
      while (history.length && now - history[0].at > 5000) history.shift()
      const span = history.length > 1 ? (now - history[0].at) / 1000 : 0
      const validWindow = history.filter(item => item.valid).length
      const uniqueWindow = new Set(history.filter(item => item.frameId !== null).map(item => item.frameId)).size
      const invalidWindow = history.length - validWindow
      const usefulShards = history[history.length - 1].shards - history[0].shards
      const usefulShardBytes = history[history.length - 1].shardBytes - history[0].shardBytes
      const recoveredBlocks = history[history.length - 1].recoveredBlocks - history[0].recoveredBlocks
      const storedBytes = history[history.length - 1].storedBytes - history[0].storedBytes
      const advancing = history.filter(item => item.frameId !== null && item.frameId > 0)
      const senderSpan = advancing.length > 1 ? (advancing[advancing.length - 1].at - advancing[0].at) / 1000 : 0
      const observedSenderFps = senderSpan > 0 ? Math.min(profile.targetDisplayFps, Math.max(0, (advancing[advancing.length - 1].frameId! - advancing[0].frameId!) / senderSpan)) : 0
      if (transferring && history.length >= 3 && span >= 2) {
        const code = adaptivePace.current.update({ processedFrames: history.length, validFrames: validWindow, uniqueFrames: uniqueWindow, usefulShards, usefulShardBytes, recoveredBlocks, storedBytes, observedSenderFps, spanSeconds: span }, now)
        if (code !== pacingCode.current) { pacingCode.current = code; setRecommendedPace(opticalPaceFps(code)) }
      }
      if (result.sampledCells && gridRef.current) {
        const canvas = gridRef.current, dimensions = frameDimensions(profile)
        canvas.width = dimensions.width; canvas.height = dimensions.height
        const context = canvas.getContext('2d')
        if (context) { const image = context.createImageData(canvas.width, canvas.height), grid = { profile, width: dimensions.width, height: dimensions.height, cells: result.sampledCells }; for (let index = 0; index < result.sampledCells.length; index += 1) writeOpticalCellRgba(grid, index, image.data, index * 4); context.putImageData(image, 0, 0) }
      }
      if (now - lastUi > 250) {
        lastUi = now
        setOpticalRecovery({ recovered: event.data.temporalRecoveries || 0, candidates: event.data.temporalCandidates || 0, headerFrame: result.header?.frameId ?? -1, payloadBytes: result.header?.payloadLength ?? 0 })
        setPaceDiagnostics(previous => ({ ...previous, validFps: span > 0 ? validWindow / span : 0, uniqueFps: span > 0 ? uniqueWindow / span : 0, invalidFps: span > 0 ? invalidWindow / span : 0, senderFps: observedSenderFps, usefulKBps: span > 0 ? usefulShardBytes / span / 1024 : 0, storedKBps: span > 0 ? storedBytes / span / 1024 : 0, cameraFps: cameraFrames.fps }))
        const boundary = result.boundary
        const dimensions = frameDimensions(profile)
        const pixelsPerCell = boundary ? Math.min(Math.hypot(boundary.topRight.x - boundary.topLeft.x, boundary.topRight.y - boundary.topLeft.y) / dimensions.width, Math.hypot(boundary.bottomLeft.x - boundary.topLeft.x, boundary.bottomLeft.y - boundary.topLeft.y) / dimensions.height) : 0
        setStatus({ camera: `${video.videoWidth} × ${video.videoHeight}`, finder: event.data.finderStage, reason: result.ok ? 'CRC-valid optical frame' : result.reason, recovery: result.ok ? result.recovery || 'none' : 'none', frame: result.ok ? result.header.frameId : -1, valid, failed, unique: seen.size, processingFps: span > 0 ? (history.length - 1) / span : 0, validFps: span > 0 ? validWindow / span : 0, usefulKBps: history.reduce((sum, item) => sum + item.bytes, 0) / 5120, decodeMs: event.data.decodeMs, acquireMs: event.data.acquireMs, drawMs: event.data.drawMs, readMs: event.data.readMs, sampleMs: event.data.sampleMs, crcMs: event.data.crcMs, pixelPath: event.data.pixelPath, gpuDiagnostic: event.data.gpuDiagnostic, pixelsPerCell, confidence: result.symbolConfidence || 0, deterministic: result.ok && isDeterministicPayload(result.payload, result.header.frameId), boundary: boundary ? `${Math.round(boundary.topLeft.x)},${Math.round(boundary.topLeft.y)} → ${Math.round(boundary.bottomRight.x)},${Math.round(boundary.bottomRight.y)}` : 'searching', fileSymbols: fileDecodeStats.current.symbols, invalidSymbols: fileDecodeStats.current.invalidSymbols, sessionRejects: fileDecodeStats.current.sessionRejects, manifestShards: fileDecodeStats.current.manifestShards, lastFileBlock: fileDecodeStats.current.lastBlock })
      }
    }
    void (async () => {
      try {
        try { stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { min: 30, ideal: 60 } } }) }
        catch (error) {
          if ((error as { name?: string }).name !== 'OverconstrainedError') throw error
          stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60 } } })
        }
        if (cancelled) { stream.getTracks().forEach(track => track.stop()); return }
        video.srcObject = stream; await video.play()
        if (cancelled) { stream.getTracks().forEach(track => track.stop()); video.srcObject = null; return }
        cameraTrackRef.current = stream.getVideoTracks()[0] || null
        if (cameraTrackRef.current) setCameraSettings(cameraSettingsSummary(cameraTrackRef.current))
        const capture = (now: number) => {
          if (cancelled || busy || !video.videoWidth || now - lastCapture < 1000 / profile.expectedCameraFps) return
          busy = true; lastCapture = now
          void createImageBitmap(video).then(bitmap => { if (cancelled) { bitmap.close(); return } worker.postMessage({ bitmap, profileId: profile.id, sentAt: now }, [bitmap]) }).catch(() => { busy = false; setStatus(previous => ({ ...previous, reason: 'Camera frame capture failed' })) })
        }
        if (typeof video.requestVideoFrameCallback === 'function') {
          const observe = (now: number, metadata: VideoFrameCallbackMetadata) => {
            if (cancelled) return
            cameraFrames.add(now, metadata.presentedFrames)
            capture(now)
            videoCallback = video.requestVideoFrameCallback(observe)
          }
          videoCallback = video.requestVideoFrameCallback(observe)
        } else {
          const captureFallback = (now: number) => {
            if (cancelled) return
            capture(now)
            animation = requestAnimationFrame(captureFallback)
          }
          animation = requestAnimationFrame(captureFallback)
        }
      } catch { setStatus(previous => ({ ...previous, reason: 'Camera permission or worker unavailable' })) }
    })()
    return () => { cancelled = true; cancelAnimationFrame(animation); if (videoCallback !== null) video.cancelVideoFrameCallback(videoCallback); cameraTrackRef.current = null; stream?.getTracks().forEach(track => track.stop()); video.pause(); video.srcObject = null; worker.terminate(); workerRef.current = null }
  }, [profile, task, connectionMode, audioSessionId, cameraActive])
  useEffect(() => {
    if (cameraActive) return
    const grid = gridRef.current
    grid?.getContext('2d')?.clearRect(0, 0, grid.width, grid.height)
  }, [cameraActive])
  const exportMetrics = () => {
    const content = JSON.stringify({ kind: 'physical-optical-diagnostics', timestamp: new Date().toISOString(), profile: profile.id, task, ...status, paceDiagnostics, opticalRecovery, cameraSettings, cameraControlStatus, recommendedPace, fileProgress, sparseReception: { missingBlocks: fileState.current.received.missingCount, recoveredBlocks: fileDecodeStats.current.recoveredBlocks, duplicateBlockFrames: duplicateBlocks.current, usefulOpticalFrames: fileDecodeStats.current.usefulShards, wastedOpticalFrames: wastedFrames.current }, speakerStatus }, null, 2)
    const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }))
    const link = document.createElement('a'); link.href = url; link.download = 'optical-diagnostics.json'; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const changeExposure = async (short: boolean) => {
    const track = cameraTrackRef.current
    if (!track) return
    try {
      const applied = short ? await applyShortExposure(track) : await restoreAutoExposure(track)
      setCameraSettings(cameraSettingsSummary(track))
      setCameraControlStatus(applied ? short ? 'Short exposure enabled; check CRC and brightness' : 'Automatic exposure restored' : 'Camera did not confirm the requested exposure mode')
    } catch (error) { setCameraControlStatus(`Camera exposure control failed: ${error instanceof Error ? error.message : String(error)}`) }
  }
  return <main style={{ maxWidth: 1180, margin: '28px auto', padding: 20, fontFamily: 'system-ui, sans-serif' }}>
    <h1>High-Speed Optical</h1>
    <p>Point this camera at the sender screen. This device sends its handshake response through the speaker; the sender listens with its microphone. Match the sender profile.</p>
    <nav><button onClick={() => { resetFile(); setTask('file') }}>Receive files</button> <button onClick={() => { resetFile(); setTask('benchmark') }}>Link benchmark</button></nav>
    {task === 'file' && <label>Connection <select value={connectionMode} disabled={!!speaker.current || !!fileState.current.manifest} onChange={event => { resetFile(); setConnectionMode(event.target.value as ConnectionMode); setAudioPacketsSent(0) }}><option value="direct">Direct optical (existing)</option><option value="audio">Audio pairing + ACK</option></select></label>}
    {task === 'file' && connectionMode === 'audio' && <p><label><input type="checkbox" checked={handsFreePairing} onChange={event => setHandsFreePairing(event.target.checked)} /> Hands-free code continuation after 3 seconds (encrypted, but peer identity not verified)</label></p>}
    <label>Optical profile <select value={profile.id} onChange={event => { resetFile(); setProfile(OPTICAL_PROFILES.find(item => item.id === event.target.value) || DEBUG_PROFILE) }}>{OPTICAL_PROFILES.map(item => <option key={item.id} value={item.id}>{item.gridWidth}×{item.gridHeight} / {item.colorMode === 'rgb' ? 'RGB + black · robust 2×2 (experimental)' : item.bitsPerSymbol === 2 ? '4-level gray (experimental)' : item.id === 'binary-320x180' ? 'dense binary · 2× widescreen payload (experimental)' : item.id === 'binary-240x120' ? 'binary widescreen (+20% cells; test camera)' : 'binary'}</option>)}</select></label>
    <button onClick={() => workerRef.current?.postMessage({ reset: true, profileId: profile.id })}>Re-detect boundary</button>
    <button onClick={exportMetrics}>Export metrics JSON</button>
    {task === 'file' && <><button onClick={() => void startSpeaker()} disabled={!!speaker.current || verified.current || (connectionMode === 'audio' && diskStorage === 'checking')}>{connectionMode === 'audio' ? 'Enable receiver speaker' : 'Enable speaker feedback'}</button>{connectionMode === 'audio' && <p>Enable the speaker, then aim this camera at the sender’s full-screen optical offer. The receiver does not need a microphone.</p>}{connectionMode === 'audio' && handshakeState === 'AWAITING_USER_VERIFICATION' && <p role="alert">Pairing code on both devices: <strong style={{ fontSize: '1.4em' }}>{sas}</strong><br />{handsFreePairing ? `Continuing in ${verificationSeconds}s · peer identity unverified` : 'Compare the codes before accepting.'}<br /><button onClick={() => acceptSas(true)}>Codes match</button> <button onClick={cancelHandshake}>Cancel</button></p>}<p>{speakerStatus} · {audioPacketsSent} control packets sent{connectionMode === 'audio' && ` · secure handshake ${handshakeState} · ${handshakeRef.current.selectedMode === 32 ? 'OFDM' : `${handshakeRef.current.selectedMode || 8}-FSK`}${responseRounds > 0 && handshakeState !== 'ESTABLISHED' ? ` · audio response round ${responseRounds}` : ''}${handshakeRef.current.selectivePackets ? ` · ${handshakeRef.current.selectivePackets} selectively replayed` : ''} · scheduled handshake airtime ${(handshakeRef.current.acousticAirtimeSeconds || 0).toFixed(1)} s${handshakeState === 'ESTABLISHED' ? ` · Encrypted · AES-256-GCM · ${sasManuallyVerifiedRef.current ? 'code manually confirmed' : 'peer identity unverified'}` : ''} · optical link ${opticalLink} · recommended optical pace ${recommendedPace || 'measuring'} FPS`}</p><p>{fileStatus} {downloadUrl && <a href={downloadUrl} download="optical-transfer.zip">Download verified ZIP</a>}</p>{!cameraActive && <p>Camera off after verified transfer. Select Receive files to start another.</p>}</>}
    {task === 'file' && <p>Local ZIP storage: {diskStorage === 'checking' ? 'checking…' : diskStorage === 'opfs' ? 'browser-private file system' : diskStorage === 'indexeddb' ? 'IndexedDB blocks' : 'memory only'}</p>}
    {task === 'file' && diskStorage === 'memory' && <p role="alert">This browser has no writable local storage for large ZIPs. It can receive up to 16 MiB in memory. Use a normal browser window with IndexedDB or browser-private file storage for larger transfers. {storageProblem}</p>}
    {task === 'file' && fileProgress.totalBytes === 0 && <p>0 ZIP bytes received · {status.sessionRejects > 0 ? 'optical frames belong to a different audio session; re-pair the sender' : status.manifestShards > 0 ? `waiting for transfer manifest (${status.manifestShards} of 8 distinct symbols)` : 'waiting for transfer manifest'}</p>}
    {task === 'file' && fileProgress.totalBytes > 0 && <div style={{ margin: '16px 0' }}><p><strong>{fileProgress.receivedBytes.toLocaleString()} / {fileProgress.totalBytes.toLocaleString()} ZIP bytes received ({(100 * fileProgress.receivedBytes / fileProgress.totalBytes).toFixed(1)}%)</strong></p><progress aria-label="ZIP bytes received" value={fileProgress.receivedBytes} max={fileProgress.totalBytes} style={{ width: '100%', height: 20 }} /><p>Blocks {fileProgress.blocks} / {fileProgress.totalBlocks} · {fileProgress.totalBlocks - fileProgress.blocks} missing · duplicate-block frames {duplicateBlocks.current} · useful/wasted optical frames {fileDecodeStats.current.usefulShards}/{wastedFrames.current} · average {fileProgress.elapsedSeconds >= 1 ? `${(fileProgress.receivedBytes / fileProgress.elapsedSeconds / 1e6).toFixed(3)} MB/s` : 'measuring'} · {fileProgress.verifiedBytes ? 'SHA-256 verified' : fileProgress.blocks < fileProgress.totalBlocks ? 'receiving missing blocks; SHA-256 starts when all are stored' : 'all blocks stored; checking local SHA-256'}</p></div>}
    {profile.colorMode === 'rgb' && status.recovery !== 'none' && <p>RGB optical correction used: {status.recovery}</p>}
    {cameraSettings && <p>Camera configured {cameraSettings.width}×{cameraSettings.height} at {cameraSettings.configuredFps || 'unknown'} FPS · exposure {cameraSettings.exposureMode}{cameraSettings.exposureTime !== null ? ` (${cameraSettings.exposureTime} × 100 µs)` : ''} · focus {cameraSettings.focusMode}. {cameraSettings.canShortenExposure && cameraSettings.exposureMode !== 'manual' && <button onClick={() => void changeExposure(true)}>Try short exposure (experimental)</button>}{cameraSettings.exposureMode === 'manual' && cameraSettings.canRestoreAuto && <button onClick={() => void changeExposure(false)}>Restore automatic exposure</button>} {cameraControlStatus}</p>}
    {task === 'file' && <p>Optical payload: {opticalRecovery.payloadBytes || 'unknown'} bytes · last readable header frame {opticalRecovery.headerFrame < 0 ? '—' : opticalRecovery.headerFrame} · repeat candidates {opticalRecovery.candidates} · CRC-verified temporal recoveries {opticalRecovery.recovered}</p>}
    {task === 'file' && connectionMode === 'audio' && calibrationMode.current === 'transferring' && <p>Recent optical delivery: camera {paceDiagnostics.cameraFps ? paceDiagnostics.cameraFps.toFixed(1) : 'unavailable'} / processed {status.processingFps.toFixed(1)} / valid {paceDiagnostics.validFps.toFixed(1)} FPS · new FEC {paceDiagnostics.usefulKBps.toFixed(1)} KB/s · stored ZIP {paceDiagnostics.storedKBps.toFixed(1)} KB/s · sender observed {paceDiagnostics.senderFps.toFixed(1)} FPS · {paceDiagnostics.invalidFps.toFixed(1)} invalid FPS · requesting {recommendedPace} FPS over sound</p>}
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 320px', gap: 20, marginTop: 16 }}>
      <video ref={videoRef} muted playsInline style={{ width: '100%', background: '#111' }} />
      <aside><h2>Diagnostics</h2><p>{status.reason}</p>{profile.bitsPerSymbol === 2 && status.pixelsPerCell > 0 && status.pixelsPerCell < 4 && <p role="alert">Four-level grid is too small in the camera image. Move closer or use the same binary profile on both devices.</p>}{profile.id === 'binary-320x180' && status.pixelsPerCell > 0 && status.pixelsPerCell < 4 && <p role="alert">Dense binary cells occupy fewer than four camera pixels. Move closer or return both devices to 240×120 if CRC-valid frames drop.</p>}<dl><dt>Camera</dt><dd>{status.camera}</dd><dt>Finder</dt><dd>{status.finder}</dd><dt>Detected boundary</dt><dd>{status.boundary}</dd><dt>Camera pixels / cell</dt><dd>{status.pixelsPerCell ? `${status.pixelsPerCell.toFixed(1)}${status.pixelsPerCell < 6 ? ' · move camera closer' : ''}` : '—'}</dd><dt>Frame</dt><dd>{status.frame < 0 ? '—' : status.frame}</dd><dt>Processed / valid FPS</dt><dd>{status.processingFps.toFixed(1)} / {status.validFps.toFixed(1)}</dd><dt>Decode time</dt><dd>{status.decodeMs.toFixed(1)} ms</dd><dt>Pixel path</dt><dd>{status.pixelPath}</dd><dt>GPU candidate</dt><dd>{status.gpuDiagnostic}</dd><dt>Stages</dt><dd>find {status.acquireMs.toFixed(0)} · draw {status.drawMs.toFixed(0)} · read {status.readMs.toFixed(0)} · sample {status.sampleMs.toFixed(0)} · CRC {status.crcMs.toFixed(0)} ms</dd><dt>Unique optical bytes</dt><dd>{status.usefulKBps.toFixed(1)} KB/s</dd><dt>Valid / failed</dt><dd>{status.valid} / {status.failed}</dd><dt>Unique frames</dt><dd>{status.unique}</dd>{task === 'file' && <><dt>File symbols decoded</dt><dd>{status.fileSymbols}</dd><dt>Wrong audio session</dt><dd>{status.sessionRejects}</dd><dt>Invalid file symbols</dt><dd>{status.invalidSymbols}</dd><dt>Manifest shards</dt><dd>{status.manifestShards} / 8</dd><dt>Last file block</dt><dd>{status.lastFileBlock < 0 ? '—' : status.lastFileBlock}</dd></>}<dt>Symbol confidence</dt><dd>{(status.confidence * 100).toFixed(0)}%</dd>{task === 'benchmark' && <><dt>Benchmark payload</dt><dd>{status.deterministic ? 'verified' : '—'}</dd></>}</dl><canvas ref={gridRef} aria-label="Sampled optical grid" style={{ width: '100%', imageRendering: 'pixelated', border: '1px solid #777' }} /></aside>
    </div>
  </main>
}
