import { useEffect, useRef, useState } from 'react'
import { ReedSolomonErasure } from '@digitaldefiance/reed-solomon-erasure.wasm/browser'
import reedSolomonWasmUrl from '@digitaldefiance/reed-solomon-erasure.wasm/wasm?url'
import { AcousticFragmentReassembler, CALIBRATION_END_STAGE, CALIBRATION_STAGE_MS, ControlType, DEBUG_PROFILE, HANDSHAKE_CAPABILITY_QUAD_CONTROL, HANDSHAKE_CAPABILITY_QUAD_FSK, OPTICAL_PROFILES, OpticalBlockEncryptor, PROTOCOL_VERSION, ReedSolomonBlockCodec, SYMBOL_HEADER_BYTES, TRANSFER_MANIFEST_BYTES, calibrationFrameId, calibrationRates, decodeFskSamples, decodeQuadFskSamples, decodeHandshakeResponse, decodeReadyConfirm, deriveHandshakeMaterial, encodeHandshakeOffer, encodeKeyConfirm, encodeOpticalFrame, framePayloadCapacity, generateEphemeralKeyPair, keyConfirm, makeOffer, opticalProfileNumber, packOpticalSymbol, packTransferManifest, parseHandshakeFragment, readBlockStatusPayload, readCompactStatusPayload, readyConfirm, type HandshakeMaterial, type HandshakeOffer, type OpticalProfile } from '@qrcopy/optical-core'
import { OpticalRenderer, scheduleOpticalFrames } from './OpticalRenderer'
import { createLocalOpticalArchive, readTransferBlock } from './local-archive'
import { createVirtualZipArchive, type ArchiveSource } from './virtual-zip'
import { AudioBlockScheduler } from './audio-block-scheduler'
import { applyCompactBlockStatus } from './compact-ack'
import { AudioPaceController } from './audio-pace'
import { RotatingShardOrder } from './shard-order'

const SOURCE_SHARDS = 8, REPAIR_SHARDS = 2
const RECEIVER_MEMORY_LIMIT = 16 * 1024 * 1024
interface FileTransfer { id: number; archive: ArchiveSource; staging: 'disk' | 'virtual'; manifest: Uint8Array; cleanup?: () => Promise<void>; archiveBytes: number; totalBlocks: number; shardBytes: number; blockBytes: number; secure?: { offer: HandshakeOffer; material: HandshakeMaterial; encryptor: OpticalBlockEncryptor } }
interface StagedArchive { archive: ArchiveSource; digest: Uint8Array; staging: FileTransfer['staging']; cleanup?: () => Promise<void> }
type ConnectionMode = 'direct' | 'audio'
type SenderHandshakeState = 'IDLE' | 'GENERATING_OFFER' | 'DISPLAYING_OFFER' | 'WAITING_FOR_AUDIO_RESPONSE' | 'ASSEMBLING_AUDIO_RESPONSE' | 'DERIVING_KEYS' | 'AWAITING_USER_VERIFICATION' | 'SENDING_KEY_CONFIRM' | 'WAITING_FOR_READY' | 'ESTABLISHED' | 'FAILED' | 'CANCELLED'

export function OpticalFileSender() {
  const directoryInput = useRef<HTMLInputElement>(null), canvasRef = useRef<HTMLCanvasElement>(null), opticalStageRef = useRef<HTMLDivElement>(null), renderer = useRef<OpticalRenderer | null>(null), codec = useRef<ReedSolomonBlockCodec | null>(null)
  const acked = useRef(new Set<number>()), microphone = useRef<MediaStream | null>(null), audioContext = useRef<AudioContext | null>(null), audioTimer = useRef<number | null>(null), audioChunks = useRef<Float32Array[]>([]), seenPackets = useRef(new Set<string>())
  const transferRef = useRef<FileTransfer | null>(null), pairedIdRef = useRef<number | null>(null), completedRef = useRef(false), preparingRef = useRef(false), receiverStorageRef = useRef<'unknown' | 'disk' | 'memory'>('unknown')
  const handshakeRef = useRef<{ state: SenderHandshakeState; privateKey?: Uint8Array; offer?: HandshakeOffer; responseCapabilities?: number; material?: HandshakeMaterial; reassembler: AcousticFragmentReassembler }>({ state: 'IDLE', reassembler: new AcousticFragmentReassembler() })
  const responseFragmentsRef = useRef(new Set<number>()), readyFragmentsRef = useRef(new Set<number>())
  const autoPrepareAttemptedRef = useRef(false), sasManuallyVerifiedRef = useRef(false)
  const stagedArchiveRef = useRef<StagedArchive | null>(null), stagingPromiseRef = useRef<Promise<StagedArchive> | null>(null), stageGenerationRef = useRef(0)
  const profileRef = useRef<OpticalProfile>(DEBUG_PROFILE), alignmentConfirmedRef = useRef(false), startedRef = useRef(false), calibratingRef = useRef(false), manuallyPausedRef = useRef(false), receiverPausedRef = useRef(false), lastControlSequence = useRef<number | null>(null), acknowledgedFloor = useRef(0), nextFrameIdRef = useRef(1)
  const paceController = useRef(new AudioPaceController(DEBUG_PROFILE.targetDisplayFps / DEBUG_PROFILE.frameHoldCount))
  const diskStorageRef = useRef<'checking' | 'available' | 'unavailable'>('checking')
  const [files, setFiles] = useState<File[]>([]), [profile, setProfile] = useState<OpticalProfile>(DEBUG_PROFILE), [transfer, setTransfer] = useState<FileTransfer | null>(null), [running, setRunning] = useState(false), [started, setStarted] = useState(false), [status, setStatus] = useState('Loading erasure codec…'), [frame, setFrame] = useState(0), [currentBlock, setCurrentBlock] = useState(0)
  const [connectionMode, setConnectionMode] = useState<ConnectionMode>('direct'), [pairedId, setPairedId] = useState<number | null>(null)
  const [audioStatus, setAudioStatus] = useState('Microphone off'), [ackCount, setAckCount] = useState(0), [audioPackets, setAudioPackets] = useState(0)
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
  const [handsFreePairing, setHandsFreePairing] = useState(true), [verificationSeconds, setVerificationSeconds] = useState(3)
  useEffect(() => { profileRef.current = profile; if (!transferRef.current) { const fps = profile.targetDisplayFps / profile.frameHoldCount; paceController.current = new AudioPaceController(fps); setLogicalFps(fps) } }, [profile])
  useEffect(() => { directoryInput.current?.setAttribute('webkitdirectory', ''); directoryInput.current?.setAttribute('directory', '') }, [])
  useEffect(() => { let cancelled = false; void ReedSolomonErasure.fromUrl(reedSolomonWasmUrl).then(engine => { if (!cancelled) { codec.current = new ReedSolomonBlockCodec(engine); setStatus('Offline ready. You can disconnect networking before selecting a directory.') } }).catch(() => setStatus('Could not load local erasure codec')); return () => { cancelled = true } }, [])
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
  useEffect(() => { transferRef.current = transfer; return () => transfer?.secure?.encryptor.clear() }, [transfer])
  useEffect(() => () => { stageGenerationRef.current += 1; void stagedArchiveRef.current?.cleanup?.(); stagedArchiveRef.current = null }, [])
  const applyAudioPace = (code: number, beforeTransmission: boolean) => {
    if (paceController.current.update(code, performance.now(), beforeTransmission)) setLogicalFps(paceController.current.currentFps)
  }
  const stopMicrophone = () => { if (audioTimer.current !== null) window.clearInterval(audioTimer.current); audioTimer.current = null; microphone.current?.getTracks().forEach(track => track.stop()); microphone.current = null; void audioContext.current?.close(); audioContext.current = null; audioChunks.current = []; seenPackets.current.clear(); setAudioStatus('Microphone off') }
  useEffect(() => () => stopMicrophone(), [])
  const beginOffer = () => {
    const keys = generateEphemeralKeyPair(), offer = makeOffer(keys, HANDSHAKE_CAPABILITY_QUAD_FSK | HANDSHAKE_CAPABILITY_QUAD_CONTROL), compactId = new DataView(offer.sessionId.buffer, offer.sessionId.byteOffset, 4).getUint32(0)
    handshakeRef.current = { state: 'DISPLAYING_OFFER', privateKey: keys.privateKey, offer, reassembler: new AcousticFragmentReassembler() }
    autoPrepareAttemptedRef.current = false; sasManuallyVerifiedRef.current = false
    responseFragmentsRef.current.clear(); readyFragmentsRef.current.clear(); setAudioFragmentProgress({ messageType: 0, heard: 0, total: 0 })
    pairedIdRef.current = compactId; setPairedId(compactId); setSas(null); setHandshakeState('DISPLAYING_OFFER')
    setAudioStatus('Microphone listening; displaying optical offer with four-tone handshake support…')
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
        if (length < context.sampleRate * 2) return
        const samples = new Float32Array(length); let offset = 0
        for (const chunk of audioChunks.current) { samples.set(chunk, offset); offset += chunk.length }
        const runtimeQuad = connectionMode === 'audio' && !!transferRef.current && !!(handshakeRef.current.responseCapabilities && (handshakeRef.current.responseCapabilities & HANDSHAKE_CAPABILITY_QUAD_CONTROL))
        const packets = runtimeQuad ? decodeQuadFskSamples(samples, context.sampleRate) : decodeFskSamples(samples, context.sampleRate)
        if (connectionMode === 'audio' && !transferRef.current) packets.push(...decodeQuadFskSamples(samples, context.sampleRate))
        for (const packet of packets) {
          const key = `${packet.transferId}:${packet.type}:${packet.sequence}`
          if (seenPackets.current.has(key)) continue
          if (seenPackets.current.size > 256) seenPackets.current.clear()
          seenPackets.current.add(key)
          if (connectionMode === 'audio' && !transferRef.current && pairedIdRef.current !== null && packet.transferId === pairedIdRef.current && packet.type === ControlType.HANDSHAKE_FRAGMENT) {
            const fragment = parseHandshakeFragment(packet)
            if (fragment && fragment.sessionTag === (pairedIdRef.current & 0xffff) && ((fragment.messageType === 1 && (handshakeRef.current.state === 'DISPLAYING_OFFER' || handshakeRef.current.state === 'WAITING_FOR_AUDIO_RESPONSE' || handshakeRef.current.state === 'ASSEMBLING_AUDIO_RESPONSE')) || (fragment.messageType === 2 && handshakeRef.current.state === 'WAITING_FOR_READY'))) {
              const seen = fragment.messageType === 1 ? responseFragmentsRef.current : readyFragmentsRef.current
              seen.add(fragment.index)
              setAudioFragmentProgress({ messageType: fragment.messageType, heard: seen.size, total: fragment.count })
              if (fragment.messageType === 1 && (handshakeRef.current.state === 'DISPLAYING_OFFER' || handshakeRef.current.state === 'WAITING_FOR_AUDIO_RESPONSE')) {
                handshakeRef.current.state = 'ASSEMBLING_AUDIO_RESPONSE'; setHandshakeState('ASSEMBLING_AUDIO_RESPONSE')
              }
              if (handshakeRef.current.state === 'ASSEMBLING_AUDIO_RESPONSE' || handshakeRef.current.state === 'WAITING_FOR_READY') setAudioStatus(`Received ${seen.size}/${fragment.count} acoustic handshake fragments`)
            }
            const assembled = handshakeRef.current.reassembler.add(packet)
            if (assembled?.messageType === 1) {
              const response = decodeHandshakeResponse(assembled.message), handshake = handshakeRef.current
              if (!response || !handshake.offer || !handshake.privateKey || (handshake.state !== 'DISPLAYING_OFFER' && handshake.state !== 'WAITING_FOR_AUDIO_RESPONSE' && handshake.state !== 'ASSEMBLING_AUDIO_RESPONSE')) continue
              try {
                handshake.state = 'DERIVING_KEYS'; setHandshakeState('DERIVING_KEYS')
                handshake.material = deriveHandshakeMaterial(handshake.offer, response, handshake.privateKey)
                handshake.responseCapabilities = response.capabilities
                handshake.state = 'AWAITING_USER_VERIFICATION'; setHandshakeState('AWAITING_USER_VERIFICATION'); setSas(handshake.material.sas)
                setAudioStatus(`Receiver detected via ${response.capabilities & HANDSHAKE_CAPABILITY_QUAD_FSK ? 'four-tone' : 'two-tone fallback'} audio. Verify the pairing code on both devices.`)
              } catch { handshake.state = 'FAILED'; setHandshakeState('FAILED'); setAudioStatus('Rejected an unbound or replayed handshake response') }
            } else if (assembled?.messageType === 2) {
              const handshake = handshakeRef.current, ready = decodeReadyConfirm(assembled.message)
              if (ready && handshake.offer && handshake.material && ready.sessionId.every((value, index) => value === handshake.offer!.sessionId[index]) && ready.confirmation.every((value, index) => value === readyConfirm(handshake.material!.keys.handshakeConfirmKey, handshake.material!.transcriptHash)[index])) {
                handshake.state = 'ESTABLISHED'; setHandshakeState('ESTABLISHED'); setAudioStatus(sasManuallyVerifiedRef.current ? 'Pairing code manually confirmed · Encrypted · AES-256-GCM' : 'Hands-free pairing · Encrypted · peer identity unverified')
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
            }
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
            if (compactStatus) {
              acknowledgedFloor.current = applyCompactBlockStatus(acked.current, acknowledgedFloor.current, active.totalBlocks, compactStatus)
              if (startedRef.current) applyAudioPace(compactStatus.paceCode, false)
            } else if (legacyStatus) for (let bit = 0; bit < 32; bit += 1) if ((legacyStatus.bitmap >>> bit) & 1) { const index = legacyStatus.baseBlock + bit; if (index < active.totalBlocks) acked.current.add(index) }
            active.secure?.encryptor.evictAcknowledged(acked.current, startedRef.current ? undefined : 0)
            setAckCount(acked.current.size); setAudioStatus(`${packet.type === ControlType.READY ? 'Receiver confirmed optical session' : 'Acoustic block feedback received'} · ${acked.current.size}/${active.totalBlocks} blocks`)
          } else if (packet.type === ControlType.CALIBRATION_SELECTED) {
            if (!calibratingRef.current || packet.payload.length !== 4 || packet.payload[0] !== opticalProfileNumber(profileRef.current) || packet.payload[1] !== PROTOCOL_VERSION || packet.payload[2] === 0) continue
            applyAudioPace(packet.payload[2], true)
            calibratingRef.current = false; setCalibrating(false)
            startedRef.current = true; manuallyPausedRef.current = false
            active.secure?.encryptor.evictAcknowledged(acked.current)
            setStarted(true); setRunning(true)
            setStatus(`Calibration confirmed over sound. Transmitting at ${paceController.current.currentFps} logical FPS.`)
          } else if (packet.type === ControlType.TRANSFER_COMPLETE) {
            completedRef.current = true; setCompleted(true); setRunning(false); calibratingRef.current = false; setCalibrating(false)
            renderer.current?.clear()
            if (document.fullscreenElement === opticalStageRef.current) void document.exitFullscreen().catch(() => {})
            active.secure?.encryptor.clear(); handshakeRef.current.privateKey?.fill(0); handshakeRef.current.material?.keys.opticalEncryptionKey.fill(0); handshakeRef.current.material?.keys.handshakeConfirmKey.fill(0); handshakeRef.current.material?.keys.sessionBindingKey.fill(0)
            stopMicrophone()
            setAudioStatus('Receiver verified transfer · microphone off')
            setStatus('Transfer complete. Optical display cleared.')
            break
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
      ? encodeKeyConfirm(handshake.offer.sessionId, keyConfirm(handshake.material!.keys.handshakeConfirmKey, handshake.material!.transcriptHash))
      : encodeHandshakeOffer(handshake.offer)
    let cancelled = false, frameId = 0
    const show = () => { if (cancelled) return; renderer.current?.render(encodeOpticalFrame(payload, frameId++ >>> 0, 0, profileRef.current)); window.setTimeout(show, 400) }
    show()
    return () => { cancelled = true }
  }, [connectionMode, transfer, handshakeState])

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
  const cancelHandshake = () => { const handshake = handshakeRef.current; handshake.privateKey?.fill(0); handshake.material?.keys.opticalEncryptionKey.fill(0); handshake.material?.keys.handshakeConfirmKey.fill(0); handshake.material?.keys.sessionBindingKey.fill(0); handshake.reassembler.clear(); handshakeRef.current = { state: 'CANCELLED', reassembler: new AcousticFragmentReassembler() }; responseFragmentsRef.current.clear(); readyFragmentsRef.current.clear(); autoPrepareAttemptedRef.current = false; sasManuallyVerifiedRef.current = false; setAudioFragmentProgress({ messageType: 0, heard: 0, total: 0 }); pairedIdRef.current = null; setPairedId(null); setSas(null); setHandshakeState('CANCELLED'); renderer.current?.clear(); setAudioStatus('Secure pairing cancelled') }
  const encryptTransferBlock = async (item: FileTransfer, blockId: number, source: Uint8Array) => {
    if (!item.secure) return source
    return item.secure.encryptor.encrypt(blockId, source)
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
      const shardBytes = Math.floor((framePayloadCapacity(profile) - SYMBOL_HEADER_BYTES) / 32) * 32
      const blockBytes = shardBytes * SOURCE_SHARDS - 1 - (connectionMode === 'audio' ? 16 : 0)
      const totalBlocks = Math.ceil((TRANSFER_MANIFEST_BYTES + archiveBytes) / blockBytes)
      const manifest = packTransferManifest({ transferId: id, archiveBytes, blockBytes, totalBlocks, sha256: digest })
      acked.current.clear(); setAckCount(0)
      completedRef.current = false; setCompleted(false)
      alignmentConfirmedRef.current = false; setAlignmentConfirmed(false); startedRef.current = false; calibratingRef.current = false; setCalibrating(false); manuallyPausedRef.current = false; receiverPausedRef.current = false; lastControlSequence.current = null; acknowledgedFloor.current = 0
      const initialFps = profile.targetDisplayFps / profile.frameHoldCount
      paceController.current = new AudioPaceController(initialFps); setLogicalFps(initialFps)
      nextFrameIdRef.current = 1
      const secure = connectionMode === 'audio' ? { offer: handshakeRef.current.offer!, material: handshakeRef.current.material!, encryptor: new OpticalBlockEncryptor(handshakeRef.current.material!.keys.opticalEncryptionKey, handshakeRef.current.material!.keys.sessionBindingKey.slice(0, 6), handshakeRef.current.offer!.sessionId, id) } : undefined
      const prepared: FileTransfer = { id, archive, staging, manifest, cleanup, archiveBytes, totalBlocks, shardBytes, blockBytes, secure }
      stagedArchiveRef.current = null
      transferRef.current = prepared; setTransfer(prepared)
      setStarted(false); setRunning(false); setFrame(0); setCurrentBlock(0)
      setStatus(connectionMode === 'audio' ? 'ZIP prepared. Aim the receiver camera at the alignment block; the link will calibrate before file transmission.' : 'ZIP prepared. Aim the receiver camera at the slowly cycling alignment block, then select Start transmission.')
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
      const block = codec.current!.encode(source, transfer.shardBytes, SOURCE_SHARDS, REPAIR_SHARDS)
      if (cancelled) return
      let shardIndex = 0
      const show = () => {
        if (cancelled) return
        const packet = packOpticalSymbol({ transferId: transfer.id, blockId: 0, index: shardIndex, sourceCount: SOURCE_SHARDS, repairCount: REPAIR_SHARDS, sourceBytes: block.sourceBytes, bytes: block.symbols[shardIndex] })
        renderer.current?.render(encodeOpticalFrame(packet, 0, 0, profile))
        shardIndex = (shardIndex + 1) % block.symbols.length
        // Vary the hold slightly so display/camera clocks cannot stay locked
        // to the same subset of manifest shards during alignment.
        timer = window.setTimeout(show, 380 + shardIndex % 3 * 90)
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
      const block = codec.current!.encode(source, transfer.shardBytes, SOURCE_SHARDS, REPAIR_SHARDS)
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
        const packet = packOpticalSymbol({ transferId: transfer.id, blockId: 0, index: symbolIndex, sourceCount: SOURCE_SHARDS, repairCount: REPAIR_SHARDS, sourceBytes: block.sourceBytes, bytes: block.symbols[symbolIndex] })
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
    let frameId = nextFrameIdRef.current, blockIndex = -1, loadingBlock = -1, displayedBlock = -1, encoded: ReturnType<ReedSolomonBlockCodec['encode']> | null = null, stopped = false
    const audioBlocks = new AudioBlockScheduler(SOURCE_SHARDS + REPAIR_SHARDS)
    const shardOrder = new RotatingShardOrder(SOURCE_SHARDS + REPAIR_SHARDS)
    const render = () => {
      if (completedRef.current) return
      let nextBlock: number
      if (connectionMode === 'audio') {
        nextBlock = audioBlocks.next(frameId, transfer.totalBlocks, acked.current)
      } else {
        nextBlock = Math.floor(frameId / (SOURCE_SHARDS + REPAIR_SHARDS)) % transfer.totalBlocks
        if (frameId % (SOURCE_SHARDS + REPAIR_SHARDS) === 0) {
          while (acked.current.has(nextBlock) && acked.current.size < transfer.totalBlocks) { frameId += SOURCE_SHARDS + REPAIR_SHARDS; nextBlock = Math.floor(frameId / (SOURCE_SHARDS + REPAIR_SHARDS)) % transfer.totalBlocks }
        }
      }
      if (nextBlock < 0 || nextBlock >= transfer.totalBlocks || acked.current.size >= transfer.totalBlocks) return
      if (nextBlock !== blockIndex || !encoded) {
        if (loadingBlock !== nextBlock) {
          loadingBlock = nextBlock
          void (async () => {
            const source = await encryptTransferBlock(transfer, nextBlock, await readTransferBlock(transfer.archive, transfer.manifest, nextBlock, transfer.blockBytes))
            const block = codec.current!.encode(source, transfer.shardBytes, SOURCE_SHARDS, REPAIR_SHARDS)
            if (stopped || loadingBlock !== nextBlock) return
            encoded = block; blockIndex = nextBlock
          })().catch(error => setStatus(error instanceof Error ? error.message : 'Could not read local optical block'))
        }
        return
      }
      const symbolIndex = shardOrder.index(nextBlock, frameId)
      const packet = packOpticalSymbol({ transferId: transfer.id, blockId: blockIndex, index: symbolIndex, sourceCount: SOURCE_SHARDS, repairCount: REPAIR_SHARDS, sourceBytes: encoded.sourceBytes, bytes: encoded.symbols[symbolIndex] })
      renderer.current?.render(encodeOpticalFrame(packet, frameId, blockIndex, profile))
      if (displayedBlock !== blockIndex) { displayedBlock = blockIndex; setCurrentBlock(blockIndex) }
      frameId += 1
      nextFrameIdRef.current = frameId
      if (frameId % 8 === 0) setFrame(frameId)
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
    transferRef.current = null; pairedIdRef.current = null; setPairedId(null)
    receiverStorageRef.current = 'unknown'; setReceiverStorage('unknown')
    alignmentConfirmedRef.current = false; startedRef.current = false; calibratingRef.current = false
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
    <label>Profile <select value={profile.id} disabled={!!transfer || (connectionMode === 'audio' && !!microphone.current)} onChange={event => setProfile(OPTICAL_PROFILES.find(item => item.id === event.target.value) || DEBUG_PROFILE)}>{OPTICAL_PROFILES.map(item => <option key={item.id} value={item.id}>{item.gridWidth}×{item.gridHeight} / {item.bitsPerSymbol === 2 ? '4-level (experimental)' : 'binary'}</option>)}</select></label>
    <input ref={directoryInput} type="file" multiple disabled={!!microphone.current || !!transfer || preparing || stagingZip} onChange={event => { discardStagedArchive(); autoPrepareAttemptedRef.current = false; setFiles(Array.from(event.target.files || [])) }} style={{ display: 'block', margin: '12px auto' }} />
    {connectionMode === 'direct' && <><button disabled={!files.length || !codec.current || diskStorage === 'checking' || !!transfer || preparing || completed} onClick={() => void prepare()}>{preparing ? 'Preparing ZIP…' : 'Prepare ZIP'}</button>{' '}</>}
    {connectionMode === 'audio' && handshakeState === 'ESTABLISHED' && !transfer && autoPrepareAttemptedRef.current && !preparing && <><button onClick={() => void prepare()}>Retry ZIP preparation</button>{' '}</>}
    <button disabled={!transfer || completed || (connectionMode === 'audio' && !started)} onClick={toggleTransmission}>{!started ? connectionMode === 'audio' ? calibrating ? 'Calibrating link' : 'Waiting for receiver alignment' : 'Start transmission' : running ? 'Pause' : 'Resume'}</button>{' '}
    <button disabled={(!transfer && !(connectionMode === 'audio' && pairedId !== null)) || completed} onClick={() => void opticalStageRef.current?.requestFullscreen()}>Full screen</button>{' '}
    <button disabled={!!microphone.current || completed || (connectionMode === 'direct' && !transfer) || (connectionMode === 'audio' && (!files.length || !codec.current || diskStorage === 'checking'))} onClick={startHandsFreeTransfer}>{connectionMode === 'audio' ? 'Start hands-free encrypted transfer' : 'Enable acoustic feedback'}</button>{' '}
    {connectionMode === 'audio' && pairedId !== null && !transfer && <button disabled={preparing} onClick={() => { cancelHandshake(); seenPackets.current.clear(); beginOffer(); setStatus('Showing a fresh optical offer for a new receiver.') }}>New pairing offer</button>}{' '}
    <button disabled={preparing} onClick={resetTransfer}>Reset</button>
    {connectionMode === 'audio' && <><p>Select files first. Start enables the microphone, prepares the ZIP locally, enters full screen, and sends automatically after the receiver confirms the session. The receiver sends its response through its speaker.</p><label><input type="checkbox" checked={handsFreePairing} onChange={event => setHandsFreePairing(event.target.checked)} /> Hands-free code continuation after 3 seconds (encrypted, but peer identity not verified)</label></>}
    <p>{status}{stagingZip && ' · ZIP preparation in progress'}</p><p>{audioStatus}{pairedId !== null && <span> · session {pairedId.toString(16).padStart(8, '0')} · receiver storage {receiverStorage}</span>} · {audioPackets} control packets received</p>{connectionMode === 'audio' && <p>Secure handshake: {handshakeState}{audioFragmentProgress.total > 0 && handshakeState !== 'ESTABLISHED' && ` · ${audioFragmentProgress.heard}/${audioFragmentProgress.total} ${audioFragmentProgress.messageType === 1 ? 'response' : 'confirmation'} fragments heard`}{handshakeState === 'ESTABLISHED' && ` · Encrypted · AES-256-GCM · ${sasManuallyVerifiedRef.current ? 'code manually confirmed' : 'peer identity unverified'}`}</p>}{transfer && <p>Transfer {transfer.id.toString(16).padStart(8, '0')} · {transfer.archiveBytes.toLocaleString()} ZIP bytes · block {currentBlock + 1} / {transfer.totalBlocks} · {ackCount} blocks acknowledged · 8 source + 2 repair symbols · optical frame sequence {frame} (repeats do not advance blocks){connectionMode === 'audio' && ` · Encrypted · AES-256-GCM · camera alignment ${alignmentConfirmed ? 'confirmed by sound' : 'awaiting sound'} · ${logicalFps} logical FPS`}</p>}
    <div ref={opticalStageRef} className="optical-stage">
      {connectionMode === 'audio' && pairedId !== null && <div className="optical-stage-status">{handshakeState === 'AWAITING_USER_VERIFICATION' ? handsFreePairing ? `Continuing encrypted pairing in ${verificationSeconds}s · peer identity unverified` : 'Compare pairing codes on both devices' : handshakeState === 'ESTABLISHED' ? `Encrypted · AES-256-GCM · ${sasManuallyVerifiedRef.current ? 'code manually confirmed' : 'peer identity unverified'}` : handshakeState === 'DISPLAYING_OFFER' ? 'Optical offer: aim receiver camera here, then enable its speaker' : handshakeState === 'ASSEMBLING_AUDIO_RESPONSE' ? `Listening to receiver audio: ${audioFragmentProgress.heard}/${audioFragmentProgress.total} fragments heard` : handshakeState === 'WAITING_FOR_READY' ? `Waiting for receiver confirmation: ${audioFragmentProgress.messageType === 2 ? `${audioFragmentProgress.heard}/${audioFragmentProgress.total} fragments heard` : 'listening…'}` : `Secure handshake: ${handshakeState}`}</div>}
      {connectionMode === 'audio' && handshakeState === 'AWAITING_USER_VERIFICATION' && <div role="alert" className="optical-stage-verification"><strong>{sas}</strong><div><button onClick={() => acceptSas(true)}>Codes match</button> <button onClick={cancelHandshake}>Cancel</button></div></div>}
      <canvas ref={canvasRef} aria-label="Optical file transfer frame" style={{ display: completed ? 'none' : 'block', width: '100%', maxHeight: '75vh', objectFit: 'contain', imageRendering: 'pixelated', background: 'white' }} />
    </div>
  </section>
}
