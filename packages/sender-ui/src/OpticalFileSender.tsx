import { useEffect, useRef, useState } from 'react'
import { ReedSolomonErasure } from '@digitaldefiance/reed-solomon-erasure.wasm/browser'
import reedSolomonWasmUrl from '@digitaldefiance/reed-solomon-erasure.wasm/wasm?url'
import { CALIBRATION_END_STAGE, CALIBRATION_STAGE_MS, ControlType, DEBUG_PROFILE, OPTICAL_PROFILES, PROTOCOL_VERSION, ReedSolomonBlockCodec, SYMBOL_HEADER_BYTES, TRANSFER_MANIFEST_BYTES, calibrationFrameId, calibrationRates, decodeFskSamples, encodeOpticalFrame, framePayloadCapacity, opticalProfileNumber, packOpticalSymbol, packTransferManifest, readBlockStatusPayload, readCompactStatusPayload, type OpticalProfile } from '@qrcopy/optical-core'
import { OpticalRenderer, scheduleOpticalFrames } from './OpticalRenderer'
import { createLocalOpticalArchive, readTransferBlock } from './local-archive'
import { createVirtualZipArchive, type ArchiveSource } from './virtual-zip'
import { AudioBlockScheduler } from './audio-block-scheduler'
import { applyCompactBlockStatus } from './compact-ack'
import { AudioPaceController } from './audio-pace'
import { RotatingShardOrder } from './shard-order'

const SOURCE_SHARDS = 8, REPAIR_SHARDS = 2
const RECEIVER_MEMORY_LIMIT = 16 * 1024 * 1024
interface FileTransfer { id: number; archive: ArchiveSource; staging: 'disk' | 'virtual'; manifest: Uint8Array; cleanup?: () => Promise<void>; archiveBytes: number; totalBlocks: number; shardBytes: number; blockBytes: number }
type ConnectionMode = 'direct' | 'audio'

export function OpticalFileSender() {
  const directoryInput = useRef<HTMLInputElement>(null), canvasRef = useRef<HTMLCanvasElement>(null), renderer = useRef<OpticalRenderer | null>(null), codec = useRef<ReedSolomonBlockCodec | null>(null)
  const acked = useRef(new Set<number>()), microphone = useRef<MediaStream | null>(null), audioContext = useRef<AudioContext | null>(null), audioTimer = useRef<number | null>(null), audioChunks = useRef<Float32Array[]>([]), seenPackets = useRef(new Set<string>())
  const transferRef = useRef<FileTransfer | null>(null), pairedIdRef = useRef<number | null>(null), completedRef = useRef(false), preparingRef = useRef(false), receiverStorageRef = useRef<'unknown' | 'disk' | 'memory'>('unknown')
  const profileRef = useRef<OpticalProfile>(DEBUG_PROFILE), alignmentConfirmedRef = useRef(false), startedRef = useRef(false), calibratingRef = useRef(false), manuallyPausedRef = useRef(false), receiverPausedRef = useRef(false), lastControlSequence = useRef<number | null>(null), acknowledgedFloor = useRef(0), nextFrameIdRef = useRef(1)
  const paceController = useRef(new AudioPaceController(DEBUG_PROFILE.targetDisplayFps / DEBUG_PROFILE.frameHoldCount))
  const diskStorageRef = useRef<'checking' | 'available' | 'unavailable'>('checking')
  const [files, setFiles] = useState<File[]>([]), [profile, setProfile] = useState<OpticalProfile>(DEBUG_PROFILE), [transfer, setTransfer] = useState<FileTransfer | null>(null), [running, setRunning] = useState(false), [started, setStarted] = useState(false), [status, setStatus] = useState('Loading erasure codec…'), [frame, setFrame] = useState(0), [currentBlock, setCurrentBlock] = useState(0)
  const [connectionMode, setConnectionMode] = useState<ConnectionMode>('direct'), [pairedId, setPairedId] = useState<number | null>(null)
  const [audioStatus, setAudioStatus] = useState('Microphone off'), [ackCount, setAckCount] = useState(0), [audioPackets, setAudioPackets] = useState(0)
  const [completed, setCompleted] = useState(false)
  const [preparing, setPreparing] = useState(false)
  const [receiverStorage, setReceiverStorage] = useState<'unknown' | 'disk' | 'memory'>('unknown')
  const [diskStorage, setDiskStorage] = useState<'checking' | 'available' | 'unavailable'>('checking')
  const [zipMode, setZipMode] = useState<'source' | 'compressed'>('source')
  const [alignmentConfirmed, setAlignmentConfirmed] = useState(false)
  const [calibrating, setCalibrating] = useState(false), [logicalFps, setLogicalFps] = useState(DEBUG_PROFILE.targetDisplayFps / DEBUG_PROFILE.frameHoldCount)
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
  useEffect(() => { transferRef.current = transfer }, [transfer])
  const applyAudioPace = (code: number, beforeTransmission: boolean) => {
    if (paceController.current.update(code, performance.now(), beforeTransmission)) setLogicalFps(paceController.current.currentFps)
  }
  const stopMicrophone = () => { if (audioTimer.current !== null) window.clearInterval(audioTimer.current); audioTimer.current = null; microphone.current?.getTracks().forEach(track => track.stop()); microphone.current = null; void audioContext.current?.close(); audioContext.current = null; audioChunks.current = []; seenPackets.current.clear(); setAudioStatus('Microphone off') }
  useEffect(() => () => stopMicrophone(), [])
  const startMicrophone = async () => {
    if ((connectionMode === 'direct' && !transferRef.current) || microphone.current) return
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
        for (const packet of decodeFskSamples(samples, context.sampleRate)) {
          const key = `${packet.transferId}:${packet.type}:${packet.sequence}`
          if (seenPackets.current.has(key)) continue
          if (seenPackets.current.size > 256) seenPackets.current.clear()
          seenPackets.current.add(key)
          if (connectionMode === 'audio' && packet.type === ControlType.HELLO && packet.payload.length <= 1 && !transferRef.current) {
            if (pairedIdRef.current === null) {
              pairedIdRef.current = packet.transferId; setPairedId(packet.transferId)
              setAudioStatus(`Paired by sound with session ${packet.transferId.toString(16).padStart(8, '0')}`)
            }
            if (pairedIdRef.current === packet.transferId) {
              setAudioPackets(value => value + 1)
              const storage = packet.payload.length ? (packet.payload[0] === 1 ? 'disk' : 'memory') : 'unknown'
              receiverStorageRef.current = storage; setReceiverStorage(storage)
            }
            continue
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
            setAckCount(acked.current.size); setAudioStatus(`${packet.type === ControlType.READY ? 'Receiver confirmed optical session' : 'Acoustic block feedback received'} · ${acked.current.size}/${active.totalBlocks} blocks`)
          } else if (packet.type === ControlType.CALIBRATION_SELECTED) {
            if (!calibratingRef.current || packet.payload.length !== 4 || packet.payload[0] !== opticalProfileNumber(profileRef.current) || packet.payload[1] !== PROTOCOL_VERSION || packet.payload[2] === 0) continue
            applyAudioPace(packet.payload[2], true)
            calibratingRef.current = false; setCalibrating(false)
            startedRef.current = true; manuallyPausedRef.current = false
            setStarted(true); setRunning(true)
            setStatus(`Calibration confirmed over sound. Transmitting at ${paceController.current.currentFps} logical FPS.`)
          } else if (packet.type === ControlType.TRANSFER_COMPLETE) {
            completedRef.current = true; setCompleted(true); setRunning(false); calibratingRef.current = false; setCalibrating(false)
            renderer.current?.clear()
            if (document.fullscreenElement === canvasRef.current) void document.exitFullscreen().catch(() => {})
            stopMicrophone()
            setAudioStatus('Receiver verified transfer · microphone off')
            setStatus('Transfer complete. Optical display cleared.')
            break
          }
        }
      }, 1000)
      setAudioStatus(connectionMode === 'audio' ? 'Listening for receiver HELLO tone' : 'Listening for physical speaker feedback')
    } catch (error) { stopMicrophone(); setAudioStatus(error instanceof Error ? error.message : 'Could not start microphone') }
  }

  const prepare = async () => {
    if (!files.length || !codec.current || diskStorageRef.current === 'checking' || transferRef.current || preparingRef.current || (connectionMode === 'audio' && pairedIdRef.current === null)) return
    preparingRef.current = true; setPreparing(true)
    setStatus('Creating local ZIP…')
    let cleanup: (() => Promise<void>) | undefined
    let stage = 'browser-private ZIP'
    try {
      const createFallback = async (): Promise<{ archive: ArchiveSource; digest: Uint8Array; staging: FileTransfer['staging'] }> => {
        stage = 'bounded-memory ZIP fallback'
        setStatus('Browser-private disk unavailable. Building a bounded-memory, uncompressed ZIP…')
        if (connectionMode === 'audio' && receiverStorageRef.current === 'memory' && files.reduce((sum, file) => sum + file.size, 0) > RECEIVER_MEMORY_LIMIT) throw new Error('Paired receiver reported memory-only storage over audio. No source file was read. Close the private receiver window, open the receiver in a normal window, and select Re-pair receiver here.')
        const virtual = await createVirtualZipArchive(files, (processed, total) => setStatus(`Building uncompressed ZIP without browser storage… ${(processed / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB scanned`))
        return { archive: virtual.archive, digest: virtual.sha256, staging: 'virtual' }
      }
      let result: { archive: ArchiveSource; digest: Uint8Array; staging: FileTransfer['staging'] }
      if (zipMode === 'compressed' && diskStorageRef.current === 'available') {
        try {
          const local = await createLocalOpticalArchive(files)
          cleanup = local.remove
          result = { archive: local.file, digest: local.sha256, staging: 'disk' }
        } catch { result = await createFallback() }
      } else result = await createFallback()
      const { archive, digest, staging } = result
      stage = 'transfer manifest'
      const archiveBytes = archive.size
      if (connectionMode === 'audio' && receiverStorageRef.current === 'memory' && archiveBytes > RECEIVER_MEMORY_LIMIT) throw new Error('Paired receiver reported memory-only storage over audio. Select Re-pair receiver after opening a normal receiver window.')
      const id = connectionMode === 'audio' ? pairedIdRef.current! : crypto.getRandomValues(new Uint32Array(1))[0]
      const shardBytes = Math.floor((framePayloadCapacity(profile) - SYMBOL_HEADER_BYTES) / 32) * 32
      const blockBytes = shardBytes * SOURCE_SHARDS - 1
      const totalBlocks = Math.ceil((TRANSFER_MANIFEST_BYTES + archiveBytes) / blockBytes)
      const manifest = packTransferManifest({ transferId: id, archiveBytes, blockBytes, totalBlocks, sha256: digest })
      acked.current.clear(); setAckCount(0)
      completedRef.current = false; setCompleted(false)
      alignmentConfirmedRef.current = false; setAlignmentConfirmed(false); startedRef.current = false; calibratingRef.current = false; setCalibrating(false); manuallyPausedRef.current = false; receiverPausedRef.current = false; lastControlSequence.current = null; acknowledgedFloor.current = 0
      const initialFps = profile.targetDisplayFps / profile.frameHoldCount
      paceController.current = new AudioPaceController(initialFps); setLogicalFps(initialFps)
      nextFrameIdRef.current = 1
      const prepared = { id, archive, staging, manifest, cleanup, archiveBytes, totalBlocks, shardBytes, blockBytes }
      transferRef.current = prepared; setTransfer(prepared)
      setStarted(false); setRunning(false); setFrame(0); setCurrentBlock(0)
      setStatus(connectionMode === 'audio' ? 'ZIP prepared. Aim the receiver camera at the alignment block; the link will calibrate before file transmission.' : 'ZIP prepared. Aim the receiver camera at the slowly cycling alignment block, then select Start transmission.')
    } catch (error) { void cleanup?.(); setStatus(`Could not prepare ${stage}: ${error instanceof Error ? error.message : String(error)}`) }
    finally { preparingRef.current = false; setPreparing(false) }
  }

  useEffect(() => {
    if (!transfer || started || calibrating || completed || !codec.current || !renderer.current) return
    let cancelled = false, timer: number | null = null
    void (async () => {
      const source = await readTransferBlock(transfer.archive, transfer.manifest, 0, transfer.blockBytes)
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
      const source = await readTransferBlock(transfer.archive, transfer.manifest, 0, transfer.blockBytes)
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
            const source = await readTransferBlock(transfer.archive, transfer.manifest, nextBlock, transfer.blockBytes)
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

  return <section style={{ maxWidth: 1180, margin: '20px auto', padding: 16, fontFamily: 'system-ui, sans-serif', textAlign: 'center' }}>
    <h2>Optical ZIP transfer</h2><p>Wait for “Offline ready” before disconnecting networking. Large directories use a bounded-memory ZIP by default. File bytes leave only as display pixels; this mode uses no network acknowledgement.</p><label>ZIP staging <select value={zipMode} disabled={!!transfer || preparing} onChange={event => setZipMode(event.target.value as 'source' | 'compressed')}><option value="source">Source files, no disk staging (uncompressed)</option><option value="compressed" disabled={diskStorage !== 'available'}>Browser-private disk (compressed){diskStorage === 'checking' ? ' — checking' : diskStorage === 'unavailable' ? ' — unavailable' : ''}</option></select></label>
    <label>Connection <select value={connectionMode} disabled={!!transfer || !!microphone.current} onChange={event => { const mode = event.target.value as ConnectionMode; setConnectionMode(mode); pairedIdRef.current = null; setPairedId(null); receiverStorageRef.current = 'unknown'; setReceiverStorage('unknown'); setAudioStatus('Microphone off') }}><option value="direct">Direct optical (existing)</option><option value="audio">Audio pairing + ACK</option></select></label>
    <label>Profile <select value={profile.id} disabled={!!transfer} onChange={event => setProfile(OPTICAL_PROFILES.find(item => item.id === event.target.value) || DEBUG_PROFILE)}>{OPTICAL_PROFILES.map(item => <option key={item.id} value={item.id}>{item.gridWidth}×{item.gridHeight} / {item.bitsPerSymbol === 2 ? '4-level (experimental)' : 'binary'}</option>)}</select></label>
    <input ref={directoryInput} type="file" multiple onChange={event => setFiles(Array.from(event.target.files || []))} style={{ display: 'block', margin: '12px auto' }} />
    <button disabled={!files.length || !codec.current || diskStorage === 'checking' || !!transfer || preparing || (connectionMode === 'audio' && pairedId === null) || completed} onClick={() => void prepare()}>{preparing ? 'Preparing ZIP…' : 'Prepare ZIP'}</button>{' '}
    <button disabled={!transfer || completed || (connectionMode === 'audio' && !started)} onClick={toggleTransmission}>{!started ? connectionMode === 'audio' ? calibrating ? 'Calibrating link' : 'Waiting for receiver alignment' : 'Start transmission' : running ? 'Pause' : 'Resume'}</button>{' '}
    <button disabled={!transfer || completed} onClick={() => void canvasRef.current?.requestFullscreen()}>Full screen</button>{' '}
    <button disabled={!!microphone.current || completed || (connectionMode === 'direct' && !transfer)} onClick={() => void startMicrophone()}>{connectionMode === 'audio' ? 'Listen for audio pairing' : 'Enable acoustic feedback'}</button>{' '}
    {connectionMode === 'audio' && pairedId !== null && !transfer && <button disabled={preparing} onClick={() => { pairedIdRef.current = null; setPairedId(null); receiverStorageRef.current = 'unknown'; setReceiverStorage('unknown'); seenPackets.current.clear(); setAudioStatus('Listening for a new receiver HELLO tone'); setStatus('Ready to pair with a different receiver. No source file has been read.'); if (!microphone.current) void startMicrophone() }}>Re-pair receiver</button>}{' '}
    <button disabled={preparing} onClick={resetTransfer}>Reset</button>
    <p>{status}</p><p>{audioStatus}{pairedId !== null && <span> · session {pairedId.toString(16).padStart(8, '0')} · receiver storage {receiverStorage}</span>} · {audioPackets} control packets received</p>{transfer && <p>Transfer {transfer.id.toString(16).padStart(8, '0')} · {transfer.archiveBytes.toLocaleString()} ZIP bytes · block {currentBlock + 1} / {transfer.totalBlocks} · {ackCount} blocks acknowledged · 8 source + 2 repair symbols · optical frame sequence {frame} (repeats do not advance blocks){connectionMode === 'audio' && ` · camera alignment ${alignmentConfirmed ? 'confirmed by sound' : 'awaiting sound'} · ${logicalFps} logical FPS`}</p>}
    <canvas ref={canvasRef} aria-label="Optical file transfer frame" style={{ display: completed ? 'none' : 'block', width: '100%', maxHeight: '75vh', objectFit: 'contain', imageRendering: 'pixelated', background: 'white' }} />
  </section>
}
