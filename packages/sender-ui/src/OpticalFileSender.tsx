import { useEffect, useRef, useState } from 'react'
import { ReedSolomonErasure } from '@digitaldefiance/reed-solomon-erasure.wasm/browser'
import reedSolomonWasmUrl from '@digitaldefiance/reed-solomon-erasure.wasm/wasm?url'
import { AcousticFragmentReassembler, CALIBRATION_END_STAGE, CALIBRATION_STAGE_MS, ControlType, DEBUG_PROFILE, HANDSHAKE_CAPABILITY_COMPACT_READY, HANDSHAKE_CAPABILITY_OCTAL_CONTROL, HANDSHAKE_CAPABILITY_OCTAL_FSK, HANDSHAKE_CAPABILITY_QUAD_CONTROL, HANDSHAKE_CAPABILITY_QUAD_FSK, HANDSHAKE_CAPABILITY_SPARSE_STREAM, OPTICAL_PROFILES, OpticalBlockEncryptor, CyclicOpticalBlockEncryptor, PROTOCOL_VERSION, ReedSolomonBlockCodec, TRANSFER_MANIFEST_BYTES, calibrationFrameId, calibrationRates, decodeFskSamples, decodeOctalFskSamples, decodeQuadFskSamples, decodeHandshakeResponse, decodeReadyConfirm, deriveHandshakeMaterial, encodeHandshakeOffer, encodeKeyConfirm, encodeKeyConfirmAudioMode, encodeOpticalFrame, generateEphemeralKeyPair, keyConfirm, keyConfirmAudioMode, makeOffer, opticalProfileNumber, packOpticalSymbol, packTransferManifest, parseHandshakeFragment, readBlockStatusPayload, readCompactStatusPayload, readMissingHintPayload, runtimeToneCount, transferCompletionTag, verifyManifestReadyTag, verifyReadyConfirm, type AcousticToneCount, type HandshakeMaterial, type HandshakeOffer, type OpticalProfile } from '@qrcopy/optical-core'
import { OPTICAL_OFFER_HOLD_MS, RGB_BOOTSTRAP_FRAME_TAG, nextOpticalOfferHold } from '@qrcopy/optical-core'
import { FastReadyAssembler, FSK_SYMBOL_SECONDS, HANDSHAKE_CAPABILITY_FAST_OCTAL, HANDSHAKE_CAPABILITY_FAST_READY, OCTAL_FAST_SYMBOL_SECONDS, equalBytes, fastReadyNegotiated, octalSymbolSeconds, readyConfirmFast } from '@qrcopy/optical-core'
import { DenseHandshakeReassembler, HANDSHAKE_CAPABILITY_DENSE_RESPONSE, HANDSHAKE_CAPABILITY_RESPONSE_PARITY, HANDSHAKE_NACK_DENSE, HANDSHAKE_NACK_LEGACY, denseHandshakeSessionTag, encodeHandshakeNack, parseDenseHandshakeFragment } from '@qrcopy/optical-core'
import { HANDSHAKE_CAPABILITY_MANIFEST_READY, HANDSHAKE_CAPABILITY_PHONE_SAFE_SHARDS } from '@qrcopy/optical-core'
import { HANDSHAKE_CAPABILITY_RECEIVER_PROFILE, agreedOpticalProfileId } from '@qrcopy/optical-core'
import { HANDSHAKE_CAPABILITY_ADAPTIVE_AUDIO, HANDSHAKE_CAPABILITY_HEX_FSK, HANDSHAKE_CAPABILITY_OFDM, acousticFallbackDecision, chooseAdaptiveAudioMode, decodeHexFskSamplesWithMetrics, decodeOfdmSamplesWithMetrics, encodeAudioModeSelect, selectedAcousticModeMatches, type ControlPacket } from '@qrcopy/optical-core'
import { OpticalRenderer, scheduleOpticalFrames } from './OpticalRenderer'
import { createLocalOpticalArchive, readTransferBlock } from './local-archive'
import { createVirtualZipArchive, type ArchiveSource } from './virtual-zip'
import { AudioBlockScheduler } from './audio-block-scheduler'
import { SparseCyclicScheduler, type SparseSelection } from './sparse-cyclic-scheduler'
import { applyCompactBlockStatus } from './compact-ack'
import { AudioPaceController } from './audio-pace'
import { opticalShardBytes } from './optical-shard-size'
import { canBeginOpticalTransfer } from './manifest-start-gate'
import { RotatingShardOrder } from './shard-order'

const SOURCE_SHARDS = 8, REPAIR_SHARDS = 2
const RECEIVER_MEMORY_LIMIT = 16 * 1024 * 1024
interface FileTransfer { id: number; archive: ArchiveSource; staging: 'disk' | 'virtual'; manifest: Uint8Array; cleanup?: () => Promise<void>; archiveBytes: number; totalBlocks: number; shardBytes: number; blockBytes: number; secure?: { offer: HandshakeOffer; material: HandshakeMaterial; encryptor: OpticalBlockEncryptor; cyclicEncryptor?: CyclicOpticalBlockEncryptor; cyclic: boolean } }
interface StagedArchive { archive: ArchiveSource; digest: Uint8Array; staging: FileTransfer['staging']; cleanup?: () => Promise<void> }
type ConnectionMode = 'direct' | 'audio'
type SenderHandshakeState = 'IDLE' | 'GENERATING_OFFER' | 'DISPLAYING_OFFER' | 'WAITING_FOR_AUDIO_RESPONSE' | 'ASSEMBLING_AUDIO_RESPONSE' | 'DERIVING_KEYS' | 'AWAITING_USER_VERIFICATION' | 'SENDING_KEY_CONFIRM' | 'WAITING_FOR_READY' | 'ESTABLISHED' | 'FAILED' | 'CANCELLED'

export function OpticalFileSender() {
  const directoryInput = useRef<HTMLInputElement>(null), canvasRef = useRef<HTMLCanvasElement>(null), opticalStageRef = useRef<HTMLDivElement>(null), renderer = useRef<OpticalRenderer | null>(null), codec = useRef<ReedSolomonBlockCodec | null>(null)
  const acked = useRef(new Set<number>()), microphone = useRef<MediaStream | null>(null), audioContext = useRef<AudioContext | null>(null), audioTimer = useRef<number | null>(null), audioChunks = useRef<Float32Array[]>([]), seenPackets = useRef(new Set<string>())
  const sparseSchedulerRef = useRef<SparseCyclicScheduler | null>(null)
  const manifestReadyRef = useRef(false), calibrationSelectedRef = useRef(false)
  const transferRef = useRef<FileTransfer | null>(null), pairedIdRef = useRef<number | null>(null), completedRef = useRef(false), preparingRef = useRef(false), receiverStorageRef = useRef<'unknown' | 'disk' | 'memory'>('unknown')
  const handshakeRef = useRef<{ state: SenderHandshakeState; privateKey?: Uint8Array; offer?: HandshakeOffer; offerStartedAt?: number; selectedAt?: number; selectedMode?: 8 | 16 | 32; probeMask?: number; estimatedSnrDb?: number; estimatedOfdmSnrDb?: number; fallbackCount?: number; responseCapabilities?: number; responseFormat?: number; responseParity?: boolean; lastResponseAt?: number; lastNackAt?: number; nackRequestId?: number; nacksSent?: number; recoveredFragments?: number; audioMode?: AcousticToneCount; octalSeconds?: number; material?: HandshakeMaterial; reassembler: AcousticFragmentReassembler; denseReassembler?: DenseHandshakeReassembler }>({ state: 'IDLE', reassembler: new AcousticFragmentReassembler() })
  const responseFragmentsRef = useRef(new Set<number>()), readyFragmentsRef = useRef(new Set<number>())
  const fastReadyAssemblerRef = useRef(new FastReadyAssembler())
  const offerHoldMsRef = useRef<number>(OPTICAL_OFFER_HOLD_MS[0])
  const autoPrepareAttemptedRef = useRef(false), sasManuallyVerifiedRef = useRef(false)
  const stagedArchiveRef = useRef<StagedArchive | null>(null), stagingPromiseRef = useRef<Promise<StagedArchive> | null>(null), stageGenerationRef = useRef(0)
  const profileRef = useRef<OpticalProfile>(DEBUG_PROFILE), alignmentConfirmedRef = useRef(false), startedRef = useRef(false), calibratingRef = useRef(false), manuallyPausedRef = useRef(false), receiverPausedRef = useRef(false), lastControlSequence = useRef<number | null>(null), acknowledgedFloor = useRef(0), nextFrameIdRef = useRef(1)
  const paceController = useRef(new AudioPaceController(DEBUG_PROFILE.targetDisplayFps / DEBUG_PROFILE.frameHoldCount))
  const erasureBytes = useRef<Uint8Array | null>(null)
  const diskStorageRef = useRef<'checking' | 'available' | 'unavailable'>('checking')
  const [files, setFiles] = useState<File[]>([]), [profile, setProfile] = useState<OpticalProfile>(DEBUG_PROFILE), [transfer, setTransfer] = useState<FileTransfer | null>(null), [running, setRunning] = useState(false), [started, setStarted] = useState(false), [status, setStatus] = useState('Loading erasure codec…'), [frame, setFrame] = useState(0), [currentBlock, setCurrentBlock] = useState(0)
  const [schedulerMetrics, setSchedulerMetrics] = useState({ cycleCount: 0, hintedRetransmissions: 0, emittedFrames: 0, completedEstimate: 0, pendingHints: 0 })
  const [connectionMode, setConnectionMode] = useState<ConnectionMode>('direct'), [pairedId, setPairedId] = useState<number | null>(null)
  const [audioStatus, setAudioStatus] = useState('Microphone off'), [ackCount, setAckCount] = useState(0), [audioPackets, setAudioPackets] = useState(0)
  const [micHealth, setMicHealth] = useState({ context: 'closed', track: 'off', inputDbfs: -120, sampleCount: 0, decodeMs: 0, decodedPackets: 0, lastMode: 'none', lastSession: 'none' })
  const [completed, setCompleted] = useState(false)
  const [preparing, setPreparing] = useState(false)
  const [stagingZip, setStagingZip] = useState(false)
  const [receiverStorage, setReceiverStorage] = useState<'unknown' | 'disk' | 'memory'>('unknown')
  const [diskStorage, setDiskStorage] = useState<'checking' | 'available' | 'unavailable'>('checking')
  const [zipMode, setZipMode] = useState<'source' | 'compressed'>('source')
  const [alignmentConfirmed, setAlignmentConfirmed] = useState(false)
  const [calibrating, setCalibrating] = useState(false), [logicalFps, setLogicalFps] = useState(DEBUG_PROFILE.targetDisplayFps / DEBUG_PROFILE.frameHoldCount)
  const [handshakeState, setHandshakeState] = useState<SenderHandshakeState>('IDLE'), [sas, setSas] = useState<string | null>(null)
  const [audioFragmentProgress, setAudioFragmentProgress] = useState({ messageType: 0, heard: 0, total: 0 })
  const [nackPayload, setNackPayload] = useState<Uint8Array | null>(null)
  const [modeSelectPayload, setModeSelectPayload] = useState<Uint8Array | null>(null)
  const [acousticMetrics, setAcousticMetrics] = useState({ mode: '8-FSK', snrDb: 0, probeErrorRate: 0, responseLossRate: 0, retransmissions: 0, elapsedSeconds: 0 })
  const [handsFreePairing, setHandsFreePairing] = useState(true), [verificationSeconds, setVerificationSeconds] = useState(3)
  // The 12 ms mode lost most handshake packets on the observed laptop pair.
  // Keep it available as an explicit experiment; default to the 16 ms mode.
  const [fastAudio, setFastAudio] = useState(false)
  const [experimentalOfdm, setExperimentalOfdm] = useState(false)
  useEffect(() => { profileRef.current = profile; if (!transferRef.current) { const fps = profile.targetDisplayFps / profile.frameHoldCount; paceController.current = new AudioPaceController(fps); setLogicalFps(fps) } }, [profile])
  useEffect(() => { directoryInput.current?.setAttribute('webkitdirectory', ''); directoryInput.current?.setAttribute('directory', '') }, [])
  useEffect(() => { let cancelled = false; void fetch(reedSolomonWasmUrl).then(response => response.arrayBuffer()).then(bytes => { if (!cancelled) { erasureBytes.current = new Uint8Array(bytes); codec.current = new ReedSolomonBlockCodec(ReedSolomonErasure.fromBytes(bytes)); setStatus('Offline ready. You can disconnect networking before selecting a directory.') } }).catch(() => setStatus('Could not load local erasure codec')); return () => { cancelled = true } }, [])
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
        await writable.close(); await root.removeEntry(name)
        if (!cancelled) { diskStorageRef.current = 'available'; setDiskStorage('available') }
      } catch { if (root && name) await root.removeEntry(name).catch(() => {}); if (!cancelled) { diskStorageRef.current = 'unavailable'; setDiskStorage('unavailable') } }
    })()
    return () => { cancelled = true }
  }, [])
  useEffect(() => { if (canvasRef.current) renderer.current = new OpticalRenderer(canvasRef.current); return () => { renderer.current = null } }, [])
  useEffect(() => () => { void transfer?.cleanup?.() }, [transfer])
  useEffect(() => { transferRef.current = transfer; return () => { transfer?.secure?.encryptor.clear(); transfer?.secure?.cyclicEncryptor?.clear() } }, [transfer])
  useEffect(() => () => { stageGenerationRef.current += 1; void stagedArchiveRef.current?.cleanup?.(); stagedArchiveRef.current = null }, [])
  const applyAudioPace = (code: number, beforeTransmission: boolean) => {
    if (paceController.current.update(code, performance.now(), beforeTransmission)) setLogicalFps(paceController.current.currentFps)
  }
  const beginFileAfterManifest = () => {
    const active = transferRef.current
    const requiresReceipt = !!(active?.secure?.cyclic && ((handshakeRef.current.responseCapabilities || 0) & HANDSHAKE_CAPABILITY_MANIFEST_READY))
    if (!active || startedRef.current || !canBeginOpticalTransfer(calibrationSelectedRef.current, requiresReceipt, manifestReadyRef.current, receiverPausedRef.current)) return
    startedRef.current = true; manuallyPausedRef.current = false
    if (!active.secure?.cyclic) active.secure?.encryptor.evictAcknowledged(acked.current)
    setStarted(true); setRunning(true)
    setStatus(`${requiresReceipt ? 'Receiver stored the encrypted manifest' : 'Calibration confirmed over sound'}. Transmitting at ${paceController.current.currentFps} logical FPS.`)
  }
  const stopMicrophone = () => { if (audioTimer.current !== null) window.clearInterval(audioTimer.current); audioTimer.current = null; microphone.current?.getTracks().forEach(track => track.stop()); microphone.current = null; void audioContext.current?.close(); audioContext.current = null; audioChunks.current = []; seenPackets.current.clear(); setMicHealth({ context: 'closed', track: 'off', inputDbfs: -120, sampleCount: 0, decodeMs: 0, decodedPackets: 0, lastMode: 'none', lastSession: 'none' }); setAudioStatus('Microphone off') }
  useEffect(() => () => stopMicrophone(), [])
  const beginOffer = (maximumMode: 8 | 16 | 32 = experimentalOfdm ? 32 : 16, fallbackCount = 0) => {
    const keys = generateEphemeralKeyPair(), offer = makeOffer(keys, HANDSHAKE_CAPABILITY_QUAD_FSK | HANDSHAKE_CAPABILITY_QUAD_CONTROL | HANDSHAKE_CAPABILITY_OCTAL_FSK | HANDSHAKE_CAPABILITY_OCTAL_CONTROL | HANDSHAKE_CAPABILITY_COMPACT_READY | HANDSHAKE_CAPABILITY_FAST_READY | HANDSHAKE_CAPABILITY_DENSE_RESPONSE | HANDSHAKE_CAPABILITY_RESPONSE_PARITY | HANDSHAKE_CAPABILITY_SPARSE_STREAM | HANDSHAKE_CAPABILITY_MANIFEST_READY | HANDSHAKE_CAPABILITY_PHONE_SAFE_SHARDS | HANDSHAKE_CAPABILITY_RECEIVER_PROFILE | (maximumMode >= 16 ? HANDSHAKE_CAPABILITY_ADAPTIVE_AUDIO | HANDSHAKE_CAPABILITY_HEX_FSK : 0) | (maximumMode === 32 ? HANDSHAKE_CAPABILITY_OFDM : 0) | (fastAudio && fallbackCount === 0 ? HANDSHAKE_CAPABILITY_FAST_OCTAL : 0)), compactId = new DataView(offer.sessionId.buffer, offer.sessionId.byteOffset, 4).getUint32(0)
    handshakeRef.current = { state: 'DISPLAYING_OFFER', privateKey: keys.privateKey, offer, offerStartedAt: performance.now(), fallbackCount, reassembler: new AcousticFragmentReassembler(), denseReassembler: new DenseHandshakeReassembler(offer.sessionId, () => new ReedSolomonBlockCodec(ReedSolomonErasure.fromBytes(new Uint8Array(erasureBytes.current!).buffer))) }
    offerHoldMsRef.current = OPTICAL_OFFER_HOLD_MS[0]
    manifestReadyRef.current = false; calibrationSelectedRef.current = false
    autoPrepareAttemptedRef.current = false; sasManuallyVerifiedRef.current = false
    responseFragmentsRef.current.clear(); readyFragmentsRef.current.clear(); fastReadyAssemblerRef.current.clear(); setAudioFragmentProgress({ messageType: 0, heard: 0, total: 0 }); setNackPayload(null); setModeSelectPayload(null)
    pairedIdRef.current = compactId; setPairedId(compactId); setSas(null); setHandshakeState('DISPLAYING_OFFER')
    setAcousticMetrics({ mode: maximumMode === 32 ? 'probing OFDM' : maximumMode === 16 ? 'probing 16-FSK' : '8-FSK baseline', snrDb: 0, probeErrorRate: 0, responseLossRate: 0, retransmissions: fallbackCount, elapsedSeconds: 0 })
    setAudioStatus(maximumMode >= 16 ? `Microphone listening; displaying optical offer and measuring 8/16-FSK${maximumMode === 32 ? '/OFDM' : ''} probes…` : `Retrying with robust eight-tone ${fastAudio ? '12 ms' : '16 ms'} audio and a fresh secure session…`)
  }
  const discardStagedArchive = () => {
    stageGenerationRef.current += 1
    if (stagedArchiveRef.current) void stagedArchiveRef.current.cleanup?.()
    stagedArchiveRef.current = null; stagingPromiseRef.current = null; setStagingZip(false)
  }
  const ensureArchiveStaged = (): Promise<StagedArchive> => {
    if (stagedArchiveRef.current) return Promise.resolve(stagedArchiveRef.current)
    if (stagingPromiseRef.current) return stagingPromiseRef.current
    const generation = stageGenerationRef.current, selectedFiles = files, selectedZipMode = zipMode
    setStagingZip(true)
    setStatus(connectionMode === 'audio' ? 'Preparing local ZIP while the secure audio handshake runs…' : 'Creating local ZIP…')
    const onProgress = (processed: number, total: number) => { if (generation === stageGenerationRef.current) setStatus(`Building uncompressed ZIP without browser storage… ${(processed / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB scanned`) }
    const task = (async (): Promise<StagedArchive> => {
      let result: StagedArchive
      if (selectedZipMode === 'compressed' && diskStorageRef.current === 'available') {
        try {
          const local = await createLocalOpticalArchive(selectedFiles)
          result = { archive: local.file, digest: local.sha256, staging: 'disk', cleanup: local.remove }
        } catch {
          const virtual = await createVirtualZipArchive(selectedFiles, onProgress)
          result = { archive: virtual.archive, digest: virtual.sha256, staging: 'virtual' }
        }
      } else {
        const virtual = await createVirtualZipArchive(selectedFiles, onProgress)
        result = { archive: virtual.archive, digest: virtual.sha256, staging: 'virtual' }
      }
      if (generation !== stageGenerationRef.current) {
        await result.cleanup?.()
        throw new Error('ZIP preparation was cancelled')
      }
      stagedArchiveRef.current = result
      if (connectionMode === 'audio') setStatus('Local ZIP prepared. Completing the secure handshake before optical transfer…')
      return result
    })()
    stagingPromiseRef.current = task
    void task.finally(() => { if (stagingPromiseRef.current === task) { stagingPromiseRef.current = null; setStagingZip(false) } }).catch(() => {})
    return task
  }
  const acceptResponseMessage = (message: Uint8Array, recovered = 0) => {
    const response = decodeHandshakeResponse(message), handshake = handshakeRef.current
    if (!response || !handshake.offer || !handshake.privateKey || (handshake.state !== 'DISPLAYING_OFFER' && handshake.state !== 'WAITING_FOR_AUDIO_RESPONSE' && handshake.state !== 'ASSEMBLING_AUDIO_RESPONSE')) return
    try {
      if (!!(response.capabilities & HANDSHAKE_CAPABILITY_DENSE_RESPONSE) !== (handshake.responseFormat === HANDSHAKE_NACK_DENSE) || !!(response.capabilities & HANDSHAKE_CAPABILITY_RESPONSE_PARITY) !== !!handshake.responseParity) throw new Error('Handshake fragment format disagreed with negotiated capabilities')
      if (!selectedAcousticModeMatches(handshake.selectedMode, response.capabilities, handshake.audioMode || 2)) throw new Error('Measured audio mode disagreed with transcript-bound response')
      handshake.state = 'DERIVING_KEYS'; setHandshakeState('DERIVING_KEYS')
      handshake.material = deriveHandshakeMaterial(handshake.offer, response, handshake.privateKey)
      const agreedProfileId = agreedOpticalProfileId(handshake.offer.capabilities, response.capabilities, opticalProfileNumber(profileRef.current), response.profileId)
      const agreedProfile = OPTICAL_PROFILES.find(item => opticalProfileNumber(item) === agreedProfileId)
      if (!agreedProfile) throw new Error('Receiver selected an unsupported optical profile')
      if (agreedProfile !== profileRef.current) { profileRef.current = agreedProfile; setProfile(agreedProfile) }
      handshake.responseCapabilities = response.capabilities
      handshake.audioMode = runtimeToneCount(response.capabilities, handshake.audioMode || 2)
      if (handshake.audioMode === 8 && handshake.octalSeconds !== octalSymbolSeconds(handshake.offer.capabilities, response.capabilities)) throw new Error('Eight-tone symbol rate did not match the negotiated response')
      handshake.recoveredFragments = recovered; setNackPayload(null); setModeSelectPayload(null)
      setAcousticMetrics(previous => ({ ...previous, mode: handshake.audioMode === 32 ? 'OFDM' : `${handshake.audioMode}-FSK`, retransmissions: (handshake.nacksSent || 0) + (handshake.fallbackCount || 0), elapsedSeconds: (performance.now() - (handshake.offerStartedAt || performance.now())) / 1000 }))
      handshake.state = 'AWAITING_USER_VERIFICATION'; setHandshakeState('AWAITING_USER_VERIFICATION'); setSas(handshake.material.sas)
      setAudioStatus(`Receiver detected via ${handshake.audioMode === 32 ? 'OFDM' : `${handshake.audioMode}-tone audio`}${recovered ? ` · ${recovered} fragment${recovered === 1 ? '' : 's'} repaired by parity` : ''}${handshake.nacksSent ? ` · ${handshake.nacksSent} selective optical NACK${handshake.nacksSent === 1 ? '' : 's'}` : ''}${agreedProfileId !== opticalProfileNumber(profile) ? ` · receiver selected ${agreedProfile.gridWidth}×${agreedProfile.gridHeight}` : ''}. Verify the pairing code on both devices.`)
    } catch (error) { handshake.privateKey?.fill(0); handshake.material?.keys.opticalEncryptionKey.fill(0); handshake.material?.keys.handshakeConfirmKey.fill(0); handshake.material?.keys.sessionBindingKey.fill(0); handshake.reassembler.clear(); handshake.denseReassembler?.clear(); handshake.state = 'FAILED'; setNackPayload(null); setModeSelectPayload(null); setHandshakeState('FAILED'); setAudioStatus(`Handshake response rejected: ${error instanceof Error ? error.message : 'invalid session'}`) }
  }
  const selectMeasuredMode = (mode: 8 | 16 | 32) => {
    const handshake = handshakeRef.current
    if (!handshake.offer || handshake.selectedMode || !(handshake.offer.capabilities & HANDSHAKE_CAPABILITY_ADAPTIVE_AUDIO)) return
    handshake.selectedMode = mode; handshake.selectedAt = performance.now()
    const probeMask = handshake.probeMask || 0, snrDb = mode === 32 ? handshake.estimatedOfdmSnrDb || 0 : handshake.estimatedSnrDb || 0
    setModeSelectPayload(encodeAudioModeSelect(handshake.offer.sessionId, mode, probeMask, snrDb))
    handshake.state = 'WAITING_FOR_AUDIO_RESPONSE'; setHandshakeState('WAITING_FOR_AUDIO_RESPONSE')
    const expectedProbes = handshake.offer.capabilities & HANDSHAKE_CAPABILITY_OFDM ? 3 : 2
    const decodedProbes = (probeMask & 1) + ((probeMask >>> 1) & 1) + ((probeMask >>> 2) & 1)
    setAcousticMetrics(previous => ({ ...previous, mode: mode === 32 ? 'OFDM selected' : `${mode}-FSK selected`, snrDb, probeErrorRate: (expectedProbes - decodedProbes) / expectedProbes }))
    setAudioStatus(`Channel probe: ${decodedProbes}/${expectedProbes} CRC-valid · estimated margin ${snrDb.toFixed(1)} dB · selecting ${mode === 32 ? 'OFDM' : `${mode}-FSK`} optically`)
  }
  const restartAtSaferMode = (saferMode: 8 | 16) => {
    const handshake = handshakeRef.current
    handshake.privateKey?.fill(0); handshake.material?.keys.opticalEncryptionKey.fill(0); handshake.material?.keys.handshakeConfirmKey.fill(0); handshake.material?.keys.sessionBindingKey.fill(0)
    handshake.reassembler.clear(); handshake.denseReassembler?.clear(); seenPackets.current.clear()
    beginOffer(saferMode, (handshake.fallbackCount || 0) + 1)
  }
  const startMicrophone = async () => {
    if ((connectionMode === 'direct' && !transferRef.current) || (connectionMode === 'audio' && (!files.length || !codec.current || diskStorageRef.current === 'checking')) || microphone.current) return
    if (connectionMode === 'audio') {
      const generation = stageGenerationRef.current
      void ensureArchiveStaged().catch(error => { if (stageGenerationRef.current === generation) setStatus(`Could not prepare ZIP: ${error instanceof Error ? error.message : String(error)}`) })
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: false, audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
      microphone.current = stream
      const context = new AudioContext(); audioContext.current = context
      await context.audioWorklet.addModule(new URL('./mic-worklet.js', import.meta.url))
      const source = context.createMediaStreamSource(stream)
      const worklet = new AudioWorkletNode(context, 'optical-mic')
      source.connect(worklet); worklet.connect(context.destination)
      worklet.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
        audioChunks.current.push(new Float32Array(event.data))
        let length = audioChunks.current.reduce((sum, chunk) => sum + chunk.length, 0)
        while (length > context.sampleRate * 6 && audioChunks.current.length > 1) length -= audioChunks.current.shift()!.length
      }
      await context.resume()
      audioTimer.current = window.setInterval(() => {
        const length = audioChunks.current.reduce((sum, chunk) => sum + chunk.length, 0)
        let remaining = Math.min(length, Math.round(context.sampleRate / 5)), energy = 0, measured = 0
        for (let index = audioChunks.current.length - 1; index >= 0 && remaining > 0; index -= 1) {
          const chunk = audioChunks.current[index], count = Math.min(remaining, chunk.length)
          for (let sample = chunk.length - count; sample < chunk.length; sample += 1) energy += chunk[sample] * chunk[sample]
          measured += count; remaining -= count
        }
        const inputDbfs = measured ? Math.max(-120, Math.round(20 * Math.log10(Math.sqrt(energy / measured) + 1e-9))) : -120
        const track = stream.getAudioTracks()[0]?.readyState || 'missing'
        if (length < context.sampleRate * 2) { setMicHealth(previous => ({ ...previous, context: context.state, track, inputDbfs, sampleCount: length, decodeMs: 0, decodedPackets: 0 })); return }
        const decodeStarted = performance.now()
        const samples = new Float32Array(length); let offset = 0
        for (const chunk of audioChunks.current) { samples.set(chunk, offset); offset += chunk.length }
        const awaitingResponse = connectionMode === 'audio' && !transferRef.current && (handshakeRef.current.state === 'DISPLAYING_OFFER' || handshakeRef.current.state === 'WAITING_FOR_AUDIO_RESPONSE' || handshakeRef.current.state === 'ASSEMBLING_AUDIO_RESPONSE')
        const modes: AcousticToneCount[] = awaitingResponse ? (handshakeRef.current.offer?.capabilities || 0) & HANDSHAKE_CAPABILITY_OFDM ? [2, 4, 8, 16, 32] : (handshakeRef.current.offer?.capabilities || 0) & HANDSHAKE_CAPABILITY_HEX_FSK ? [2, 4, 8, 16] : [2, 4, 8] : [connectionMode === 'audio' ? handshakeRef.current.audioMode || 2 : 2]
        const packets = modes.flatMap<{ packet: ControlPacket; mode: AcousticToneCount; symbolSeconds: number; estimatedSnrDb: number }>(mode => {
          const rates = mode === 8 && awaitingResponse && (handshakeRef.current.offer?.capabilities || 0) & HANDSHAKE_CAPABILITY_FAST_OCTAL ? [FSK_SYMBOL_SECONDS, OCTAL_FAST_SYMBOL_SECONDS] : [mode === 8 ? octalSymbolSeconds(handshakeRef.current.offer?.capabilities || 0, handshakeRef.current.responseCapabilities || 0) : FSK_SYMBOL_SECONDS]
          // The microphone scan runs once per second. Keep an overlapping
          // two-second OFDM window so a 200 ms packet crossing a scan boundary
          // is still captured whole on the following scan.
          const captureSeconds = mode === 32 ? 2 : 3
          const capture = (mode === 8 || mode === 16 || mode === 32) && samples.length > context.sampleRate * captureSeconds ? samples.subarray(samples.length - Math.floor(context.sampleRate * captureSeconds)) : samples
          return rates.flatMap<{ packet: ControlPacket; mode: AcousticToneCount; symbolSeconds: number; estimatedSnrDb: number }>(symbolSeconds => mode === 32
            ? decodeOfdmSamplesWithMetrics(capture, context.sampleRate).map(({ packet, estimatedSnrDb }) => ({ packet, mode, symbolSeconds, estimatedSnrDb }))
            : mode === 16
            ? decodeHexFskSamplesWithMetrics(capture, context.sampleRate).map(({ packet, estimatedSnrDb }) => ({ packet, mode, symbolSeconds, estimatedSnrDb }))
            : (mode === 8 ? decodeOctalFskSamples(capture, context.sampleRate, symbolSeconds) : mode === 4 ? decodeQuadFskSamples(samples, context.sampleRate) : decodeFskSamples(samples, context.sampleRate)).map(packet => ({ packet, mode, symbolSeconds, estimatedSnrDb: 0 })))
        })
        const observed = packets.find(item => item.packet.transferId === pairedIdRef.current) || packets[0]
        setMicHealth(previous => ({ context: context.state, track, inputDbfs, sampleCount: length, decodeMs: performance.now() - decodeStarted, decodedPackets: packets.length, lastMode: observed ? `${observed.mode === 32 ? 'OFDM' : `${observed.mode}-FSK`}` : previous.lastMode, lastSession: observed ? observed.packet.transferId.toString(16).padStart(8, '0') : previous.lastSession }))
        for (const { packet, mode, symbolSeconds, estimatedSnrDb } of packets) {
          const key = `${packet.transferId}:${packet.type}:${packet.sequence}`
          if (seenPackets.current.has(key)) continue
          if (seenPackets.current.size > 256) seenPackets.current.clear()
          seenPackets.current.add(key)
          if (connectionMode === 'audio' && packet.type === ControlType.ACOUSTIC_PROBE && packet.payload.length === 3 && pairedIdRef.current === packet.transferId && handshakeRef.current.offer && !handshakeRef.current.selectedMode && (handshakeRef.current.offer.capabilities & HANDSHAKE_CAPABILITY_HEX_FSK) && packet.payload[0] === denseHandshakeSessionTag(handshakeRef.current.offer.sessionId) && packet.payload[1] === (mode === 8 ? 0 : mode === 16 ? 1 : mode === 32 ? 2 : 255) && packet.payload[2] === mode && (mode !== 32 || handshakeRef.current.offer.capabilities & HANDSHAKE_CAPABILITY_OFDM)) {
            const handshake = handshakeRef.current
            handshake.probeMask = (handshake.probeMask || 0) | (1 << packet.payload[1])
            if (mode === 16) handshake.estimatedSnrDb = estimatedSnrDb
            if (mode === 32) handshake.estimatedOfdmSnrDb = estimatedSnrDb
            const expectedMask = handshake.offer!.capabilities & HANDSHAKE_CAPABILITY_OFDM ? 7 : 3
            if (handshake.probeMask === expectedMask) selectMeasuredMode(chooseAdaptiveAudioMode(handshake.offer!.capabilities, { octalDecoded: !!(handshake.probeMask & 1), hexDecoded: !!(handshake.probeMask & 2), estimatedSnrDb: handshake.estimatedSnrDb || 0, ofdmDecoded: !!(handshake.probeMask & 4), ofdmSnrDb: handshake.estimatedOfdmSnrDb || 0 }))
            continue
          }
          if (connectionMode === 'audio' && !transferRef.current && profileRef.current.colorMode === 'rgb' && pairedIdRef.current !== null && packet.transferId === pairedIdRef.current && packet.type === ControlType.OPTICAL_QUALITY && (handshakeRef.current.state === 'DISPLAYING_OFFER' || handshakeRef.current.state === 'WAITING_FOR_AUDIO_RESPONSE' || handshakeRef.current.state === 'ASSEMBLING_AUDIO_RESPONSE')) {
            const nextHold = nextOpticalOfferHold(offerHoldMsRef.current, pairedIdRef.current, opticalProfileNumber(profileRef.current), packet)
            if (nextHold > offerHoldMsRef.current) {
              offerHoldMsRef.current = nextHold
              setAudioStatus(`Receiver sees the RGB header but not the payload; holding each optical offer for ${offerHoldMsRef.current} ms`)
              setAudioPackets(value => value + 1)
            }
            continue
          }
          if (connectionMode === 'audio' && !transferRef.current && pairedIdRef.current !== null && packet.transferId === pairedIdRef.current && packet.type === ControlType.HANDSHAKE_COMPLETE && (handshakeRef.current.state === 'SENDING_KEY_CONFIRM' || handshakeRef.current.state === 'WAITING_FOR_READY') && fastReadyNegotiated(handshakeRef.current.offer?.capabilities || 0, handshakeRef.current.responseCapabilities || 0)) {
            const handshake = handshakeRef.current
            const mac = fastReadyAssemblerRef.current.add(packet, pairedIdRef.current)
            if (packet.payload.length === 9 && packet.payload[0] < 2) {
              readyFragmentsRef.current.add(packet.payload[0])
              setAudioFragmentProgress({ messageType: 2, heard: readyFragmentsRef.current.size, total: 2 })
            }
            if (mac && handshake.material && equalBytes(mac, readyConfirmFast(handshake.material.keys.handshakeConfirmKey, handshake.material.transcriptHash))) {
              handshake.state = 'ESTABLISHED'; setHandshakeState('ESTABLISHED')
              setAudioStatus(`${handshake.audioMode === 32 ? 'OFDM' : `${handshake.audioMode || 2}-tone audio`} established · ${sasManuallyVerifiedRef.current ? 'pairing code manually confirmed' : 'hands-free pairing · peer identity unverified'} · Encrypted · AES-256-GCM`)
            } else if (mac) setAudioStatus('Receiver READY failed transcript authentication; waiting for a valid confirmation…')
            setAudioPackets(value => value + 1); continue
          }
          if (connectionMode === 'audio' && !transferRef.current && pairedIdRef.current !== null && packet.transferId === pairedIdRef.current && packet.type === ControlType.HANDSHAKE_DENSE_FRAGMENT && handshakeRef.current.offer && (handshakeRef.current.offer.capabilities & HANDSHAKE_CAPABILITY_DENSE_RESPONSE) && (handshakeRef.current.state === 'DISPLAYING_OFFER' || handshakeRef.current.state === 'WAITING_FOR_AUDIO_RESPONSE' || handshakeRef.current.state === 'ASSEMBLING_AUDIO_RESPONSE')) {
            const handshake = handshakeRef.current, fragment = parseDenseHandshakeFragment(packet)
            if (!fragment || !handshake.offer || fragment.sessionTag !== denseHandshakeSessionTag(handshake.offer.sessionId) || handshake.responseFormat && handshake.responseFormat !== HANDSHAKE_NACK_DENSE || handshake.responseParity !== undefined && handshake.responseParity !== !!fragment.parityCount) continue
            const assembled = handshake.denseReassembler?.add(packet)
            const progress = handshake.denseReassembler?.progress()
            if (!progress && !assembled) continue
            handshake.responseFormat = HANDSHAKE_NACK_DENSE
            handshake.responseParity = !!fragment.parityCount
            handshake.audioMode = Math.min(handshake.audioMode || mode, mode) as AcousticToneCount
            if (mode === 8) handshake.octalSeconds = symbolSeconds
            if (!responseFragmentsRef.current.has(fragment.index)) { responseFragmentsRef.current.add(fragment.index); handshake.lastResponseAt = performance.now() }
            setAudioFragmentProgress({ messageType: 1, heard: responseFragmentsRef.current.size, total: fragment.dataCount + fragment.parityCount })
            if (handshake.state !== 'ASSEMBLING_AUDIO_RESPONSE') { handshake.state = 'ASSEMBLING_AUDIO_RESPONSE'; setHandshakeState('ASSEMBLING_AUDIO_RESPONSE') }
            if (assembled) acceptResponseMessage(assembled.message, assembled.recovered)
            else setAudioStatus(`Received ${responseFragmentsRef.current.size}/${fragment.dataCount + fragment.parityCount} dense audio fragments · ${progress?.missing.length || 0} data missing`)
            setAudioPackets(value => value + 1); continue
          }
          if (connectionMode === 'audio' && !transferRef.current && pairedIdRef.current !== null && packet.transferId === pairedIdRef.current && packet.type === ControlType.HANDSHAKE_FRAGMENT) {
            const fragment = parseHandshakeFragment(packet)
            if (fragment && fragment.sessionTag === (pairedIdRef.current & 0xffff) && ((fragment.messageType === 1 && (handshakeRef.current.state === 'DISPLAYING_OFFER' || handshakeRef.current.state === 'WAITING_FOR_AUDIO_RESPONSE' || handshakeRef.current.state === 'ASSEMBLING_AUDIO_RESPONSE') && (!handshakeRef.current.responseFormat || handshakeRef.current.responseFormat === HANDSHAKE_NACK_LEGACY)) || (fragment.messageType === 2 && handshakeRef.current.state === 'WAITING_FOR_READY'))) {
              if (fragment.messageType === 1) {
                handshakeRef.current.responseFormat = HANDSHAKE_NACK_LEGACY
                handshakeRef.current.audioMode = Math.min(handshakeRef.current.audioMode || mode, mode) as AcousticToneCount
                if (mode === 8) handshakeRef.current.octalSeconds = symbolSeconds
              }
              const seen = fragment.messageType === 1 ? responseFragmentsRef.current : readyFragmentsRef.current
              if (!seen.has(fragment.index)) { seen.add(fragment.index); if (fragment.messageType === 1) handshakeRef.current.lastResponseAt = performance.now() }
              setAudioFragmentProgress({ messageType: fragment.messageType, heard: seen.size, total: fragment.count })
              if (fragment.messageType === 1 && (handshakeRef.current.state === 'DISPLAYING_OFFER' || handshakeRef.current.state === 'WAITING_FOR_AUDIO_RESPONSE')) {
                handshakeRef.current.state = 'ASSEMBLING_AUDIO_RESPONSE'; setHandshakeState('ASSEMBLING_AUDIO_RESPONSE')
              }
              if (handshakeRef.current.state === 'ASSEMBLING_AUDIO_RESPONSE' || handshakeRef.current.state === 'WAITING_FOR_READY') setAudioStatus(`Received ${seen.size}/${fragment.count} acoustic handshake fragments`)
            } else continue
            const assembled = handshakeRef.current.reassembler.add(packet)
            if (assembled?.messageType === 1) {
              acceptResponseMessage(assembled.message)
            } else if (assembled?.messageType === 2) {
              const handshake = handshakeRef.current, ready = decodeReadyConfirm(assembled.message)
              if (ready && handshake.offer && handshake.material && verifyReadyConfirm(handshake.offer.sessionId, handshake.material.keys.handshakeConfirmKey, handshake.material.transcriptHash, ready)) {
                handshake.state = 'ESTABLISHED'; setHandshakeState('ESTABLISHED'); setAudioStatus(`${handshake.audioMode === 32 ? 'OFDM' : `${handshake.audioMode || 2}-tone audio`} established · ${sasManuallyVerifiedRef.current ? 'pairing code manually confirmed' : 'hands-free pairing · peer identity unverified'} · Encrypted · AES-256-GCM`)
              } else {
                setAudioStatus('Receiver confirmation was received but failed session authentication; waiting for a valid READY…')
              }
            }
            setAudioPackets(value => value + 1); continue
          }
          const active = transferRef.current
          if (!active || packet.transferId !== active.id) continue
          const previousSequence = lastControlSequence.current
          if (previousSequence !== null) {
            const advance = (packet.sequence - previousSequence + 65536) & 0xffff
            if (advance === 0 || advance > 32767) continue
          }
          lastControlSequence.current = packet.sequence
          setAudioPackets(value => value + 1)
          if (packet.type === ControlType.PROFILE_SELECTED || packet.type === ControlType.PAUSE || packet.type === ControlType.RESUME) {
            if (packet.payload.length !== 2 || packet.payload[0] !== opticalProfileNumber(profileRef.current) || (packet.payload[1] & 15) !== PROTOCOL_VERSION) continue
            if (packet.type === ControlType.PAUSE) {
              receiverPausedRef.current = true; alignmentConfirmedRef.current = false; setAlignmentConfirmed(false); setRunning(false)
              if (calibratingRef.current) { calibratingRef.current = false; setCalibrating(false) }
              setAudioStatus('Receiver lost the optical frame · waiting for acoustic resync')
              setStatus('Optical link interrupted. Hold the display still while the receiver reacquires it.')
            } else {
              const wasInterrupted = receiverPausedRef.current
              receiverPausedRef.current = false; alignmentConfirmedRef.current = true; setAlignmentConfirmed(true)
              setAudioStatus('Receiver camera confirmed the paired optical frame and profile')
              if (startedRef.current) applyAudioPace(packet.payload[1] >>> 4, false)
              if (wasInterrupted && startedRef.current && !manuallyPausedRef.current) {
                setRunning(true); setStatus('Optical link resynchronized. Repeating unacknowledged blocks.')
              } else if (!startedRef.current && !calibratingRef.current) {
                calibratingRef.current = true; setCalibrating(true)
                setStatus('Receiver confirmed alignment. Testing optical frame rates before file transmission…')
              }
              if (calibrationSelectedRef.current && manifestReadyRef.current) beginFileAfterManifest()
            }
          } else if (packet.type === ControlType.MANIFEST_READY) {
            if (!active.secure?.cyclic || !((handshakeRef.current.responseCapabilities || 0) & HANDSHAKE_CAPABILITY_MANIFEST_READY) || !verifyManifestReadyTag(active.secure.material.keys.handshakeConfirmKey, active.secure.material.transcriptHash, active.manifest.subarray(24, 56), active.totalBlocks, packet.payload)) continue
            manifestReadyRef.current = true
            setAudioStatus('Receiver authenticated and durably stored the optical manifest')
            beginFileAfterManifest()
          } else if (packet.type === ControlType.MISSING_HINT) {
            if (!active.secure?.cyclic) continue
            const hint = readMissingHintPayload(packet.payload)
            if (!hint || !sparseSchedulerRef.current?.addHint(hint, active.totalBlocks, performance.now())) continue
            setAckCount(previous => Math.max(previous, hint.completedCount))
            setSchedulerMetrics(sparseSchedulerRef.current.metrics)
            setAudioStatus(`Sparse receiver hint: ${active.totalBlocks - hint.completedCount} blocks outstanding · continuing cyclic optical transmission`)
          } else if (packet.type === ControlType.BLOCK_STATUS || packet.type === ControlType.READY) {
            const compactStatus = readCompactStatusPayload(packet.payload)
            const legacyStatus = compactStatus ? null : readBlockStatusPayload(packet.payload)
            if (!compactStatus && !legacyStatus) continue
            // The preview may finish the manifest before its alignment tone
            // arrives. Its status still proves a paired optical frame decoded.
            if (connectionMode === 'audio' && !startedRef.current && !calibratingRef.current) {
              alignmentConfirmedRef.current = true; setAlignmentConfirmed(true)
              calibratingRef.current = true; setCalibrating(true)
              setStatus('Receiver confirmed the optical manifest. Testing optical frame rates…')
            }
            if (receiverPausedRef.current) {
              receiverPausedRef.current = false; alignmentConfirmedRef.current = true; setAlignmentConfirmed(true)
              if (startedRef.current && !manuallyPausedRef.current) { setRunning(true); setStatus('Optical link resynchronized. Repeating unacknowledged blocks.') }
            }
            if (compactStatus && active.secure?.cyclic) {
              if (startedRef.current) applyAudioPace(compactStatus.paceCode, false)
              setAudioStatus('Acoustic pace feedback received · optical cycle continues')
            } else if (compactStatus) {
              acknowledgedFloor.current = applyCompactBlockStatus(acked.current, acknowledgedFloor.current, active.totalBlocks, compactStatus)
              if (startedRef.current) applyAudioPace(compactStatus.paceCode, false)
            } else if (legacyStatus) for (let bit = 0; bit < 32; bit += 1) if ((legacyStatus.bitmap >>> bit) & 1) { const index = legacyStatus.baseBlock + bit; if (index < active.totalBlocks) acked.current.add(index) }
            if (!active.secure?.cyclic) { active.secure?.encryptor.evictAcknowledged(acked.current, startedRef.current ? undefined : 0); setAckCount(acked.current.size); setAudioStatus(`${packet.type === ControlType.READY ? 'Receiver confirmed optical session' : 'Acoustic block feedback received'} · ${acked.current.size}/${active.totalBlocks} blocks`) }
          } else if (packet.type === ControlType.CALIBRATION_SELECTED) {
            if (startedRef.current) continue
            if ((!calibratingRef.current && !calibrationSelectedRef.current) || packet.payload.length !== 4 || packet.payload[0] !== opticalProfileNumber(profileRef.current) || packet.payload[1] !== PROTOCOL_VERSION || packet.payload[2] === 0) continue
            applyAudioPace(packet.payload[2], true)
            calibratingRef.current = false; setCalibrating(false)
            calibrationSelectedRef.current = true
            if (active.secure?.cyclic && ((handshakeRef.current.responseCapabilities || 0) & HANDSHAKE_CAPABILITY_MANIFEST_READY) && !manifestReadyRef.current) setStatus('Calibration complete. Repeating the encrypted manifest until the receiver confirms durable storage…')
            beginFileAfterManifest()
          } else if (packet.type === ControlType.TRANSFER_COMPLETE) {
            if (active.secure?.cyclic && (packet.payload.length !== 12 || !equalBytes(packet.payload, transferCompletionTag(active.secure.material.keys.handshakeConfirmKey, active.secure.material.transcriptHash, active.manifest.subarray(24, 56), active.totalBlocks)))) continue
            completedRef.current = true; setCompleted(true); setRunning(false); calibratingRef.current = false; setCalibrating(false)
            renderer.current?.clear()
            if (document.fullscreenElement === opticalStageRef.current) void document.exitFullscreen().catch(() => {})
            active.secure?.encryptor.clear(); active.secure?.cyclicEncryptor?.clear(); handshakeRef.current.privateKey?.fill(0); handshakeRef.current.material?.keys.opticalEncryptionKey.fill(0); handshakeRef.current.material?.keys.handshakeConfirmKey.fill(0); handshakeRef.current.material?.keys.sessionBindingKey.fill(0)
            stopMicrophone()
            setAudioStatus('Receiver verified transfer · microphone off')
            setStatus('Transfer complete. Optical display cleared.')
            break
          }
        }
        const handshake = handshakeRef.current, compactId = pairedIdRef.current
        if (connectionMode === 'audio' && handshake.offerStartedAt) setAcousticMetrics(previous => ({ ...previous, elapsedSeconds: (performance.now() - handshake.offerStartedAt!) / 1000, retransmissions: (handshake.nacksSent || 0) + (handshake.fallbackCount || 0) }))
        if (connectionMode === 'audio' && handshake.offer && (handshake.offer.capabilities & HANDSHAKE_CAPABILITY_ADAPTIVE_AUDIO) && !handshake.selectedMode && (handshake.state === 'DISPLAYING_OFFER' || handshake.state === 'WAITING_FOR_AUDIO_RESPONSE') && performance.now() - (handshake.offerStartedAt || 0) >= 4500) {
          const mask = handshake.probeMask || 0
          selectMeasuredMode(chooseAdaptiveAudioMode(handshake.offer.capabilities, { octalDecoded: !!(mask & 1), hexDecoded: !!(mask & 2), estimatedSnrDb: handshake.estimatedSnrDb || 0, ofdmDecoded: !!(mask & 4), ofdmSnrDb: handshake.estimatedOfdmSnrDb || 0 }))
        }
        const selectionElapsed = handshake.selectedAt ? performance.now() - handshake.selectedAt : 0
        const saferMode = handshake.selectedMode ? acousticFallbackDecision(handshake.selectedMode, selectionElapsed, performance.now() - (handshake.lastResponseAt || handshake.selectedAt || performance.now()), responseFragmentsRef.current.size) : null
        if (connectionMode === 'audio' && handshake.selectedMode && handshake.state !== 'AWAITING_USER_VERIFICATION' && handshake.state !== 'ESTABLISHED' && handshake.state !== 'SENDING_KEY_CONFIRM' && handshake.state !== 'WAITING_FOR_READY' && (saferMode || (handshake.selectedMode === 8 && !handshake.lastResponseAt && selectionElapsed > 9000))) {
          if (saferMode) restartAtSaferMode(saferMode)
          else { handshake.privateKey?.fill(0); handshake.denseReassembler?.clear(); beginOffer(8, (handshake.fallbackCount || 0) + 1) }
          return
        }
        if (connectionMode === 'audio' && compactId !== null && handshake.state === 'ASSEMBLING_AUDIO_RESPONSE' && handshake.offer && handshake.responseFormat && handshake.lastResponseAt) {
          const denseProgress = handshake.responseFormat === HANDSHAKE_NACK_DENSE ? handshake.denseReassembler?.progress() : null
          const legacyProgress = handshake.responseFormat === HANDSHAKE_NACK_LEGACY ? handshake.reassembler.missing(compactId, compactId & 0xffff, 1) : null
          const count = denseProgress?.dataCount || legacyProgress?.count
          const missing = denseProgress?.missing || legacyProgress?.missing || [], now = performance.now()
          if (count && count <= 31 && missing.length && now - handshake.lastResponseAt >= 1800 && now - (handshake.lastNackAt || 0) >= 3000) {
            setAcousticMetrics(previous => ({ ...previous, responseLossRate: missing.length / count }))
            const mask = missing.reduce((value, index) => value | (1 << index), 0) >>> 0
            const requestId = ((handshake.nackRequestId || 0) + 1) & 0xffff
            handshake.nackRequestId = requestId; handshake.lastNackAt = now; handshake.nacksSent = (handshake.nacksSent || 0) + 1
            setNackPayload(encodeHandshakeNack(handshake.offer.sessionId, handshake.responseFormat, count, requestId, mask))
            setAudioStatus(`Requesting only ${missing.length} missing response fragment${missing.length === 1 ? '' : 's'} optically · NACK ${handshake.nacksSent}`)
          }
        }
      }, 1000)
      if (connectionMode === 'audio') beginOffer()
      else setAudioStatus('Listening for physical speaker feedback')
    } catch (error) { stopMicrophone(); setAudioStatus(error instanceof Error ? error.message : 'Could not start microphone') }
  }

  useEffect(() => {
    if (connectionMode !== 'audio' || transfer || !renderer.current || (handshakeState !== 'DISPLAYING_OFFER' && handshakeState !== 'WAITING_FOR_AUDIO_RESPONSE' && handshakeState !== 'ASSEMBLING_AUDIO_RESPONSE' && handshakeState !== 'SENDING_KEY_CONFIRM' && handshakeState !== 'WAITING_FOR_READY')) return
    const handshake = handshakeRef.current
    if (!handshake.offer) return
    const payload = handshakeState === 'SENDING_KEY_CONFIRM' || handshakeState === 'WAITING_FOR_READY'
      ? handshake.responseCapabilities && (handshake.responseCapabilities & HANDSHAKE_CAPABILITY_OCTAL_FSK)
        ? encodeKeyConfirmAudioMode(handshake.offer.sessionId, handshake.audioMode || 2, keyConfirmAudioMode(handshake.material!.keys.handshakeConfirmKey, handshake.material!.transcriptHash, handshake.audioMode || 2))
        : encodeKeyConfirm(handshake.offer.sessionId, keyConfirm(handshake.material!.keys.handshakeConfirmKey, handshake.material!.transcriptHash))
      : nackPayload || modeSelectPayload || encodeHandshakeOffer(handshake.offer)
    let cancelled = false, frameId = 0
    const show = () => {
      if (cancelled) return
      const rgb = profileRef.current.colorMode === 'rgb'
      const opticalFrameId = rgb ? (RGB_BOOTSTRAP_FRAME_TAG | (frameId++ & 0x00ffffff)) >>> 0 : frameId++ >>> 0
      renderer.current?.render(encodeOpticalFrame(payload, opticalFrameId, rgb ? pairedIdRef.current || 0 : 0, profileRef.current))
      window.setTimeout(show, rgb ? offerHoldMsRef.current : 400)
    }
    show()
    return () => { cancelled = true }
  }, [connectionMode, transfer, handshakeState, nackPayload, modeSelectPayload])

  const acceptSas = (manuallyVerified = false) => {
    const handshake = handshakeRef.current
    if (handshake.state !== 'AWAITING_USER_VERIFICATION' || !handshake.offer || !handshake.material) return
    sasManuallyVerifiedRef.current = manuallyVerified
    handshake.state = 'SENDING_KEY_CONFIRM'; setHandshakeState('SENDING_KEY_CONFIRM'); setAudioStatus('Sending optical key confirmation…')
    window.setTimeout(() => { if (handshakeRef.current === handshake && handshake.state === 'SENDING_KEY_CONFIRM') { handshake.state = 'WAITING_FOR_READY'; setHandshakeState('WAITING_FOR_READY'); setAudioStatus('Waiting for receiver confirmation…') } }, 600)
  }
  useEffect(() => {
    if (connectionMode !== 'audio' || !handsFreePairing || handshakeState !== 'AWAITING_USER_VERIFICATION') return
    setVerificationSeconds(3)
    const countdown = window.setInterval(() => setVerificationSeconds(value => Math.max(0, value - 1)), 1000)
    const confirm = window.setTimeout(() => acceptSas(false), 3000)
    return () => { window.clearInterval(countdown); window.clearTimeout(confirm) }
  }, [connectionMode, handsFreePairing, handshakeState])
  const cancelHandshake = () => { const handshake = handshakeRef.current; handshake.privateKey?.fill(0); handshake.material?.keys.opticalEncryptionKey.fill(0); handshake.material?.keys.handshakeConfirmKey.fill(0); handshake.material?.keys.sessionBindingKey.fill(0); handshake.reassembler.clear(); handshake.denseReassembler?.clear(); fastReadyAssemblerRef.current.clear(); handshakeRef.current = { state: 'CANCELLED', reassembler: new AcousticFragmentReassembler() }; responseFragmentsRef.current.clear(); readyFragmentsRef.current.clear(); autoPrepareAttemptedRef.current = false; sasManuallyVerifiedRef.current = false; setAudioFragmentProgress({ messageType: 0, heard: 0, total: 0 }); setNackPayload(null); setModeSelectPayload(null); pairedIdRef.current = null; setPairedId(null); setSas(null); setHandshakeState('CANCELLED'); renderer.current?.clear(); setAudioStatus('Secure pairing cancelled') }
  const encryptTransferBlock = async (item: FileTransfer, blockId: number, source: Uint8Array) => {
    if (!item.secure) return { bytes: source, visit: undefined as number | undefined }
    if (item.secure.cyclicEncryptor) return item.secure.cyclicEncryptor.encryptNext(blockId, source)
    return { bytes: await item.secure.encryptor.encrypt(blockId, source), visit: undefined as number | undefined }
  }

  const prepare = async () => {
    if (!files.length || !codec.current || diskStorageRef.current === 'checking' || transferRef.current || preparingRef.current || (connectionMode === 'audio' && handshakeRef.current.state !== 'ESTABLISHED')) return
    preparingRef.current = true; setPreparing(true)
    setStatus('Creating local ZIP…')
    let stage = 'local ZIP'
    const currentHandshake = handshakeRef.current
    try {
      if (connectionMode === 'audio' && receiverStorageRef.current === 'memory' && files.reduce((sum, file) => sum + file.size, 0) > RECEIVER_MEMORY_LIMIT) throw new Error('Paired receiver reported memory-only storage over audio. Re-open the receiver in a normal window and restart pairing.')
      const staged = await ensureArchiveStaged()
      if (connectionMode === 'audio' && (handshakeRef.current !== currentHandshake || currentHandshake.state !== 'ESTABLISHED')) throw new Error('Pairing was cancelled before transfer preparation finished')
      const { archive, digest, staging, cleanup } = staged
      stage = 'transfer manifest'
      const archiveBytes = archive.size
      if (connectionMode === 'audio' && receiverStorageRef.current === 'memory' && archiveBytes > RECEIVER_MEMORY_LIMIT) throw new Error('Paired receiver reported memory-only storage over audio. Select Re-pair receiver after opening a normal receiver window.')
      const id = connectionMode === 'audio' ? pairedIdRef.current! : crypto.getRandomValues(new Uint32Array(1))[0]
      const cyclic = connectionMode === 'audio' && !!(handshakeRef.current.responseCapabilities && (handshakeRef.current.responseCapabilities & HANDSHAKE_CAPABILITY_SPARSE_STREAM))
      const phoneSafe = !!(handshakeRef.current.responseCapabilities && (handshakeRef.current.responseCapabilities & HANDSHAKE_CAPABILITY_PHONE_SAFE_SHARDS))
      const shardBytes = opticalShardBytes(profile, phoneSafe) - (cyclic ? 4 : 0)
      const blockBytes = shardBytes * SOURCE_SHARDS - 1 - (connectionMode === 'audio' ? 16 : 0)
      const totalBlocks = Math.ceil((TRANSFER_MANIFEST_BYTES + archiveBytes) / blockBytes)
      const manifest = packTransferManifest({ transferId: id, archiveBytes, blockBytes, totalBlocks, sha256: digest })
      acked.current.clear(); setAckCount(0)
      completedRef.current = false; setCompleted(false)
      alignmentConfirmedRef.current = false; setAlignmentConfirmed(false); startedRef.current = false; calibratingRef.current = false; setCalibrating(false); manifestReadyRef.current = false; calibrationSelectedRef.current = false; manuallyPausedRef.current = false; receiverPausedRef.current = false; lastControlSequence.current = null; acknowledgedFloor.current = 0
      const initialFps = profile.targetDisplayFps / profile.frameHoldCount
      paceController.current = new AudioPaceController(initialFps); setLogicalFps(initialFps)
      nextFrameIdRef.current = 1
      const secure = connectionMode === 'audio' ? { offer: handshakeRef.current.offer!, material: handshakeRef.current.material!, encryptor: new OpticalBlockEncryptor(handshakeRef.current.material!.keys.opticalEncryptionKey, handshakeRef.current.material!.keys.sessionBindingKey.slice(0, 6), handshakeRef.current.offer!.sessionId, id), cyclicEncryptor: cyclic ? new CyclicOpticalBlockEncryptor(handshakeRef.current.material!.keys.opticalEncryptionKey, handshakeRef.current.material!.keys.sessionBindingKey.slice(0, 4), handshakeRef.current.offer!.sessionId, id) : undefined, cyclic } : undefined
      const prepared: FileTransfer = { id, archive, staging, manifest, cleanup, archiveBytes, totalBlocks, shardBytes, blockBytes, secure }
      sparseSchedulerRef.current = cyclic || connectionMode === 'direct' ? new SparseCyclicScheduler(SOURCE_SHARDS + REPAIR_SHARDS) : null
      setSchedulerMetrics({ cycleCount: 0, hintedRetransmissions: 0, emittedFrames: 0, completedEstimate: 0, pendingHints: 0 })
      stagedArchiveRef.current = null
      transferRef.current = prepared; setTransfer(prepared)
      setStarted(false); setRunning(false); setFrame(0); setCurrentBlock(0)
      setStatus(connectionMode === 'audio' ? `ZIP prepared. Aim the receiver camera at the alignment block; after calibration ${cyclic ? 'a continuous cyclic optical stream' : 'legacy ACK-paced transfer'} starts.` : 'ZIP prepared. Aim the receiver camera at the slowly cycling alignment block, then select Start transmission.')
    } catch (error) { if (connectionMode !== 'audio' || handshakeRef.current === currentHandshake) setStatus(`Could not prepare ${stage}: ${error instanceof Error ? error.message : String(error)}`) }
    finally { preparingRef.current = false; setPreparing(false) }
  }

  useEffect(() => {
    if (connectionMode !== 'audio' || handshakeState !== 'ESTABLISHED' || !files.length || !codec.current || diskStorage === 'checking' || transfer || preparing || autoPrepareAttemptedRef.current) return
    autoPrepareAttemptedRef.current = true
    void prepare()
  }, [connectionMode, handshakeState, files, diskStorage, transfer, preparing])

  useEffect(() => {
    if (!transfer || started || calibrating || completed || !codec.current || !renderer.current) return
    let cancelled = false, timer: number | null = null
    void (async () => {
      const source = await encryptTransferBlock(transfer, 0, await readTransferBlock(transfer.archive, transfer.manifest, 0, transfer.blockBytes))
      const block = codec.current!.encode(source.bytes, transfer.shardBytes, SOURCE_SHARDS, REPAIR_SHARDS)
      if (cancelled) return
      let shardIndex = 0
      const show = () => {
        if (cancelled) return
        const packet = packOpticalSymbol({ transferId: transfer.id, blockId: 0, index: shardIndex, sourceCount: SOURCE_SHARDS, repairCount: REPAIR_SHARDS, sourceBytes: block.sourceBytes, bytes: block.symbols[shardIndex], visit: source.visit })
        renderer.current?.render(encodeOpticalFrame(packet, 0, 0, profile))
        shardIndex = (shardIndex + 1) % block.symbols.length
        // A tunneled phone camera currently delivers about one decoded image
        // per second. Holding a shard for less than that yields mostly
        // rolling-shutter transitions, especially on the dense profile.
        // Vary the >1 s hold so capture/display clocks cannot phase-lock.
        const phoneRelay = !!((handshakeRef.current.responseCapabilities || 0) & HANDSHAKE_CAPABILITY_PHONE_SAFE_SHARDS)
        timer = window.setTimeout(show, phoneRelay ? 1150 + shardIndex % 3 * 170 : 380 + shardIndex % 3 * 90)
      }
      show()
    })().catch(error => { if (!cancelled) setStatus(error instanceof Error ? error.message : 'Could not show alignment frame') })
    return () => { cancelled = true; if (timer !== null) window.clearTimeout(timer) }
  }, [transfer, started, calibrating, completed, profile])

  useEffect(() => {
    if (!transfer || !calibrating || completed || !codec.current || !renderer.current) return
    let cancelled = false, timer: number | null = null
    void (async () => {
      const source = await encryptTransferBlock(transfer, 0, await readTransferBlock(transfer.archive, transfer.manifest, 0, transfer.blockBytes))
      const block = codec.current!.encode(source.bytes, transfer.shardBytes, SOURCE_SHARDS, REPAIR_SHARDS)
      if (cancelled) return
      const rates = calibrationRates(profile)
      let stage = 0, stageStarted = performance.now(), sequence = 0
      const show = () => {
        if (cancelled) return
        const now = performance.now()
        if (stage < rates.length && now - stageStarted >= CALIBRATION_STAGE_MS) {
          stage += 1; stageStarted = now; sequence = 0
          setStatus(stage < rates.length ? `Calibrating optical link at ${rates[stage]} logical FPS…` : 'Calibration frames complete. Waiting for the receiver’s audio rate selection…')
        }
        const finished = stage >= rates.length
        const symbolIndex = sequence % block.symbols.length
        const packet = packOpticalSymbol({ transferId: transfer.id, blockId: 0, index: symbolIndex, sourceCount: SOURCE_SHARDS, repairCount: REPAIR_SHARDS, sourceBytes: block.sourceBytes, bytes: block.symbols[symbolIndex], visit: source.visit })
        renderer.current?.render(encodeOpticalFrame(packet, calibrationFrameId(finished ? CALIBRATION_END_STAGE : stage, sequence), 0, profile))
        sequence += 1
        timer = window.setTimeout(show, finished ? 450 : 1000 / rates[stage])
      }
      setStatus(`Calibrating optical link at ${rates[0]} logical FPS…`)
      show()
    })().catch(error => { if (!cancelled) setStatus(error instanceof Error ? error.message : 'Could not calibrate optical display') })
    return () => { cancelled = true; if (timer !== null) window.clearTimeout(timer) }
  }, [transfer, calibrating, completed, profile])

  useEffect(() => {
    if (!transfer || !running || !codec.current || !renderer.current) return
    sparseSchedulerRef.current?.restartVisit()
    let frameId = nextFrameIdRef.current, blockIndex = -1, loadingToken: SparseSelection | number | null = null, encodedToken: SparseSelection | number | null = null, displayedBlock = -1, visit: number | undefined, encoded: ReturnType<ReedSolomonBlockCodec['encode']> | null = null, stopped = false
    const audioBlocks = new AudioBlockScheduler(SOURCE_SHARDS + REPAIR_SHARDS)
    const shardOrder = new RotatingShardOrder(SOURCE_SHARDS + REPAIR_SHARDS)
    let selectedVisit: SparseSelection | null = null, visitFrame = 0
    const render = () => {
      if (completedRef.current) return
      const selection = sparseSchedulerRef.current?.select(transfer.totalBlocks, performance.now())
      const nextBlock = selection?.blockId ?? audioBlocks.next(frameId, transfer.totalBlocks, acked.current)
      if (nextBlock < 0 || nextBlock >= transfer.totalBlocks || (!selection && acked.current.size >= transfer.totalBlocks)) return
      const token = selection || nextBlock
      if (encodedToken !== token || !encoded) {
        if (loadingToken !== token) {
          loadingToken = token
          void (async () => {
            const source = await encryptTransferBlock(transfer, nextBlock, await readTransferBlock(transfer.archive, transfer.manifest, nextBlock, transfer.blockBytes))
            const block = codec.current!.encode(source.bytes, transfer.shardBytes, SOURCE_SHARDS, REPAIR_SHARDS)
            if (stopped || loadingToken !== token) return
            encoded = block; blockIndex = nextBlock; encodedToken = token; visit = source.visit
          })().catch(error => { if (!stopped) { setStatus(error instanceof Error ? error.message : 'Could not read local optical block'); setRunning(false) } })
        }
        return
      }
      if (selection && selectedVisit !== selection) {
        selectedVisit = selection; visitFrame = 0
      }
      const symbolIndex = selection ? (visitFrame + selection.visit * 3) % (SOURCE_SHARDS + REPAIR_SHARDS) : shardOrder.index(nextBlock, frameId)
      const packet = packOpticalSymbol({ transferId: transfer.id, blockId: blockIndex, index: symbolIndex, sourceCount: SOURCE_SHARDS, repairCount: REPAIR_SHARDS, sourceBytes: encoded.sourceBytes, bytes: encoded.symbols[symbolIndex], visit })
      renderer.current?.render(encodeOpticalFrame(packet, frameId, blockIndex, profile))
      if (displayedBlock !== blockIndex) { displayedBlock = blockIndex; setCurrentBlock(blockIndex) }
      if (selection) { visitFrame += 1; sparseSchedulerRef.current!.frameEmitted() }
      frameId += 1
      nextFrameIdRef.current = frameId
      if (frameId % 8 === 0) { setFrame(frameId); if (selection) setSchedulerMetrics(sparseSchedulerRef.current!.metrics) }
    }
    const stop = scheduleOpticalFrames(profile, render, () => paceController.current.currentFps)
    return () => { stopped = true; stop() }
  }, [transfer, running, profile])

  const toggleTransmission = () => {
    if (!transfer || completed) return
    if (!started) {
      if (connectionMode === 'audio') return
      startedRef.current = true; manuallyPausedRef.current = false
      setStarted(true); setRunning(true)
      setStatus('Optical stream running. The frame sequence increases while incomplete blocks are repeated.')
    } else if (running) {
      manuallyPausedRef.current = true
      setRunning(false); setStatus('Optical stream paused on the current frame. Resume after alignment.')
    } else {
      if (connectionMode === 'audio' && !alignmentConfirmedRef.current) return
      manuallyPausedRef.current = false; setRunning(true); setStatus('Optical stream resumed. Incomplete blocks continue repeating.')
    }
  }

  const resetTransfer = () => {
    cancelHandshake()
    discardStagedArchive()
    stopMicrophone(); renderer.current?.clear(); completedRef.current = false; setCompleted(false)
    transferRef.current = null; sparseSchedulerRef.current = null; setSchedulerMetrics({ cycleCount: 0, hintedRetransmissions: 0, emittedFrames: 0, completedEstimate: 0, pendingHints: 0 }); pairedIdRef.current = null; setPairedId(null)
    receiverStorageRef.current = 'unknown'; setReceiverStorage('unknown')
    alignmentConfirmedRef.current = false; startedRef.current = false; calibratingRef.current = false; manifestReadyRef.current = false; calibrationSelectedRef.current = false
    manuallyPausedRef.current = false; receiverPausedRef.current = false; lastControlSequence.current = null
    acknowledgedFloor.current = 0; nextFrameIdRef.current = 1
    const fps = profile.targetDisplayFps / profile.frameHoldCount
    paceController.current = new AudioPaceController(fps); setLogicalFps(fps)
    setAlignmentConfirmed(false); setTransfer(null); setStarted(false); setCalibrating(false); setRunning(false)
    setFrame(0); setCurrentBlock(0); setAckCount(0); setAudioPackets(0)
    setStatus('Offline ready. You can disconnect networking before selecting a directory.')
  }
  const startHandsFreeTransfer = () => {
    if (connectionMode === 'audio') void opticalStageRef.current?.requestFullscreen().catch(() => {})
    void startMicrophone()
  }

  return <section style={{ maxWidth: 1180, margin: '20px auto', padding: 16, fontFamily: 'system-ui, sans-serif', textAlign: 'center' }}>
    <h2>Optical ZIP transfer</h2><p>Wait for “Offline ready” before disconnecting networking. Large directories use a bounded-memory ZIP by default. File bytes leave only as display pixels; this mode uses no network acknowledgement.</p><label>ZIP staging <select value={zipMode} disabled={!!transfer || preparing || stagingZip || !!microphone.current} onChange={event => { discardStagedArchive(); setZipMode(event.target.value as 'source' | 'compressed') }}><option value="source">Source files, no disk staging (uncompressed)</option><option value="compressed" disabled={diskStorage !== 'available'}>Browser-private disk (compressed){diskStorage === 'checking' ? ' — checking' : diskStorage === 'unavailable' ? ' — unavailable' : ''}</option></select></label>
    <label>Connection <select value={connectionMode} disabled={!!transfer || !!microphone.current} onChange={event => { const mode = event.target.value as ConnectionMode; setConnectionMode(mode); pairedIdRef.current = null; setPairedId(null); receiverStorageRef.current = 'unknown'; setReceiverStorage('unknown'); setAudioStatus('Microphone off') }}><option value="direct">Direct optical (existing)</option><option value="audio">Audio pairing + ACK</option></select></label>
    <label>Profile <select value={profile.id} disabled={!!transfer || (connectionMode === 'audio' && !!microphone.current)} onChange={event => setProfile(OPTICAL_PROFILES.find(item => item.id === event.target.value) || DEBUG_PROFILE)}>{OPTICAL_PROFILES.map(item => <option key={item.id} value={item.id}>{item.gridWidth}×{item.gridHeight} / {item.colorMode === 'rgb' ? 'RGB + black · robust 2×2 (experimental)' : item.bitsPerSymbol === 2 ? '4-level gray (experimental)' : item.id === 'binary-320x180' ? 'dense binary · 2× widescreen payload (experimental)' : item.id === 'binary-240x120' ? 'binary widescreen (+20% cells; test camera)' : 'binary'}</option>)}</select></label>
    <input ref={directoryInput} type="file" multiple disabled={!!microphone.current || !!transfer || preparing || stagingZip} onChange={event => { discardStagedArchive(); autoPrepareAttemptedRef.current = false; setFiles(Array.from(event.target.files || [])) }} style={{ display: 'block', margin: '12px auto' }} />
    {connectionMode === 'direct' && <><button disabled={!files.length || !codec.current || diskStorage === 'checking' || !!transfer || preparing || completed} onClick={() => void prepare()}>{preparing ? 'Preparing ZIP…' : 'Prepare ZIP'}</button>{' '}</>}
    {connectionMode === 'audio' && handshakeState === 'ESTABLISHED' && !transfer && autoPrepareAttemptedRef.current && !preparing && <><button onClick={() => void prepare()}>Retry ZIP preparation</button>{' '}</>}
    <button disabled={!transfer || completed || (connectionMode === 'audio' && !started)} onClick={toggleTransmission}>{!started ? connectionMode === 'audio' ? calibrating ? 'Calibrating link' : 'Waiting for receiver alignment' : 'Start transmission' : running ? 'Pause' : 'Resume'}</button>{' '}
    <button disabled={(!transfer && !(connectionMode === 'audio' && pairedId !== null)) || completed} onClick={() => void opticalStageRef.current?.requestFullscreen()}>Full screen</button>{' '}
    <button disabled={!!microphone.current || completed || (connectionMode === 'direct' && !transfer) || (connectionMode === 'audio' && (!files.length || !codec.current || diskStorage === 'checking'))} onClick={startHandsFreeTransfer}>{connectionMode === 'audio' ? 'Start hands-free encrypted transfer' : 'Enable acoustic feedback'}</button>{' '}
    {connectionMode === 'audio' && microphone.current && micHealth.context === 'suspended' && <button onClick={() => void audioContext.current?.resume().catch(() => setAudioStatus('Microphone could not resume; restart pairing'))}>Resume sender microphone</button>}
    {connectionMode === 'audio' && pairedId !== null && !transfer && <button disabled={preparing} onClick={() => { cancelHandshake(); seenPackets.current.clear(); beginOffer(); setStatus('Showing a fresh optical offer for a new receiver.') }}>New pairing offer</button>}{' '}
    <button disabled={preparing} onClick={resetTransfer}>Reset</button>
    {connectionMode === 'audio' && <><p>Select files first. Start enables the microphone, prepares the ZIP locally, enters full screen, and sends automatically after the receiver confirms the session. The receiver sends its response through its speaker.</p><label><input type="checkbox" checked={fastAudio} disabled={!!microphone.current} onChange={event => setFastAudio(event.target.checked)} /> Faster 8-tone audio (12 ms symbols; turn off if the acoustic link misses packets)</label><br /><label><input type="checkbox" checked={experimentalOfdm} disabled={!!microphone.current} onChange={event => setExperimentalOfdm(event.target.checked)} /> Experimental OFDM audio (automatically falls back to 16-/8-FSK if decoding fails)</label><br /><label><input type="checkbox" checked={handsFreePairing} onChange={event => setHandsFreePairing(event.target.checked)} /> Hands-free code continuation after 3 seconds (encrypted, but peer identity not verified)</label></>}
    <p>{status}{stagingZip && ' · ZIP preparation in progress'}</p><p>{audioStatus}{pairedId !== null && <span> · session {pairedId.toString(16).padStart(8, '0')} · receiver storage {receiverStorage}</span>} · {audioPackets} control packets received</p>{connectionMode === 'audio' && <p>Secure handshake: {handshakeState} · {acousticMetrics.mode} · estimated acoustic margin {acousticMetrics.snrDb.toFixed(1)} dB · probe errors {(acousticMetrics.probeErrorRate * 100).toFixed(0)}% · response loss estimate {(acousticMetrics.responseLossRate * 100).toFixed(0)}% · repairs/restarts {acousticMetrics.retransmissions} · elapsed {acousticMetrics.elapsedSeconds.toFixed(1)} s{audioFragmentProgress.total > 0 && handshakeState !== 'ESTABLISHED' && ` · ${audioFragmentProgress.heard}/${audioFragmentProgress.total} ${audioFragmentProgress.messageType === 1 ? 'response' : 'confirmation'} fragments heard`}{handshakeState === 'ESTABLISHED' && ` · Encrypted · AES-256-GCM · ${sasManuallyVerifiedRef.current ? 'code manually confirmed' : 'peer identity unverified'}`}</p>}{transfer && <p>Transfer {transfer.id.toString(16).padStart(8, '0')} · {transfer.archiveBytes.toLocaleString()} ZIP bytes · block {currentBlock + 1} / {transfer.totalBlocks} · {transfer.secure?.cyclic ? `receiver reports at least ${ackCount} stored · ${transfer.totalBlocks - ackCount} estimated missing · ${schedulerMetrics.cycleCount} complete cycles · ${schedulerMetrics.hintedRetransmissions} hinted visits · ${schedulerMetrics.emittedFrames} emitted frames` : `${ackCount} blocks acknowledged`} · 8 source + 2 repair symbols · optical frame sequence {frame}{connectionMode === 'audio' && ` · Encrypted · AES-256-GCM · camera alignment ${alignmentConfirmed ? 'confirmed by sound' : 'awaiting sound'} · ${logicalFps} logical FPS`}</p>}
    {connectionMode === 'audio' && <p>Sender microphone: track {micHealth.track} · audio context {micHealth.context} · input {micHealth.inputDbfs} dBFS · buffered {(micHealth.sampleCount / (audioContext.current?.sampleRate || 1)).toFixed(1)} s · CRC packets in last scan {micHealth.decodedPackets} · last decoded {micHealth.lastMode} / session {micHealth.lastSession}{pairedId !== null && micHealth.lastSession !== 'none' && micHealth.lastSession !== pairedId.toString(16).padStart(8, '0') ? ' (wrong session)' : ''} · decoder {micHealth.decodeMs.toFixed(0)} ms</p>}
    {transfer && connectionMode === 'audio' && <p>Optical shard size: {transfer.shardBytes} bytes{handshakeRef.current.responseCapabilities && (handshakeRef.current.responseCapabilities & HANDSHAKE_CAPABILITY_PHONE_SAFE_SHARDS) ? ' · phone-safe size authenticated in handshake' : ' · standard profile size'}</p>}
    <div ref={opticalStageRef} className="optical-stage">
      {connectionMode === 'audio' && pairedId !== null && <div className="optical-stage-status">{handshakeState === 'AWAITING_USER_VERIFICATION' ? handsFreePairing ? `Continuing encrypted pairing in ${verificationSeconds}s · peer identity unverified` : 'Compare pairing codes on both devices' : handshakeState === 'ESTABLISHED' ? `Encrypted · AES-256-GCM · ${sasManuallyVerifiedRef.current ? 'code manually confirmed' : 'peer identity unverified'}` : handshakeState === 'DISPLAYING_OFFER' ? 'Optical offer: aim receiver camera here, then enable its speaker' : handshakeState === 'ASSEMBLING_AUDIO_RESPONSE' ? `Listening to receiver audio: ${audioFragmentProgress.heard}/${audioFragmentProgress.total} fragments heard${nackPayload ? ' · requesting missing fragment(s) optically' : ''}` : handshakeState === 'WAITING_FOR_READY' ? `Waiting for receiver confirmation: ${audioFragmentProgress.messageType === 2 ? `${audioFragmentProgress.heard}/${audioFragmentProgress.total} fragments heard` : 'listening…'}` : `Secure handshake: ${handshakeState}`}</div>}
      {connectionMode === 'audio' && handshakeState === 'AWAITING_USER_VERIFICATION' && <div role="alert" className="optical-stage-verification"><strong>{sas}</strong><div><button onClick={() => acceptSas(true)}>Codes match</button> <button onClick={cancelHandshake}>Cancel</button></div></div>}
      <canvas ref={canvasRef} aria-label="Optical file transfer frame" style={{ display: completed ? 'none' : 'block', width: '100%', maxHeight: '75vh', objectFit: 'contain', imageRendering: 'pixelated', background: 'white' }} />
    </div>
  </section>
}
