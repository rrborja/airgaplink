import { useEffect, useRef, useState } from 'react'
import { ReedSolomonErasure } from '@digitaldefiance/reed-solomon-erasure.wasm/browser'
import reedSolomonWasmUrl from '@digitaldefiance/reed-solomon-erasure.wasm/wasm?url'
import { CALIBRATION_END_STAGE, CALIBRATION_STAGE_MS, ControlType, DEBUG_PROFILE, OPTICAL_PROFILES, OpticalBlockCollector, PROTOCOL_VERSION, ReedSolomonBlockCodec, TRANSFER_MANIFEST_BYTES, calibrationRates, encodeCompactFskPacket, encodeFskPacket, frameDimensions, isDeterministicPayload, makeBlockStatusPayload, makeCompactStatusPayload, opticalPaceFps, opticalProfileNumber, readCalibrationFrameId, recommendOpticalPaceCode, selectCalibratedPaceCode, unpackOpticalSymbol, unpackTransferManifest, type OpticalImageDecode, type OpticalProfile, type TransferManifest } from '@qrcopy/optical-core'
import { LocalOpticalSink } from './local-sink'
import { IndexedDbOpticalSink } from './indexeddb-sink'

type OpticalSink = LocalOpticalSink | IndexedDbOpticalSink
type StorageMode = 'checking' | 'opfs' | 'indexeddb' | 'memory'
interface FileReceiveState { id: number | null; collectors: Map<number, OpticalBlockCollector>; blocks: Map<number, Uint8Array>; received: Set<number>; receivedBytes: number; manifest: TransferManifest | null; sink: OpticalSink | null; sinkOpening: boolean; storageError: boolean; verifying: boolean }
function emptyFileState(): FileReceiveState { return { id: null, collectors: new Map(), blocks: new Map(), received: new Set(), receivedBytes: 0, manifest: null, sink: null, sinkOpening: false, storageError: false, verifying: false } }
type ConnectionMode = 'direct' | 'audio'

export function WorkerOpticalReceiver() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const gridRef = useRef<HTMLCanvasElement>(null)
  const workerRef = useRef<Worker | null>(null)
  const wasmBytes = useRef<Uint8Array | null>(null), recoveryCodec = useRef<ReedSolomonBlockCodec | null>(null), fileState = useRef<FileReceiveState>(emptyFileState())
  const speaker = useRef<AudioContext | null>(null), speakerTimer = useRef<number | null>(null), completionStopTimer = useRef<number | null>(null), audioSequence = useRef(0), verified = useRef(false), readySent = useRef(false), alignmentSeen = useRef(false), opticalLost = useRef(false), lastOpticalAt = useRef(0), resumeRepeats = useRef(0), completeSignalsSent = useRef(0), nextAudioStart = useRef(0)
  const fileDecodeStats = useRef({ symbols: 0, invalidSymbols: 0, sessionRejects: 0, manifestShards: 0, lastBlock: -1 })
  const fileStarted = useRef(0)
  const pacingCode = useRef(0)
  const calibrationMode = useRef<'idle' | 'probing' | 'selected' | 'transferring'>('idle')
  const selectedPaceCode = useRef(0)
  const calibrationSamples = useRef(new Map<number, { firstSequence: number; lastSequence: number; seen: Set<number>; firstAt: number; lastAt: number }>())
  useEffect(() => () => { void fileState.current.sink?.remove() }, [])
  const [profile, setProfile] = useState<OpticalProfile>(DEBUG_PROFILE)
  const [connectionMode, setConnectionMode] = useState<ConnectionMode>('direct')
  const [audioSessionId, setAudioSessionId] = useState(() => crypto.getRandomValues(new Uint32Array(1))[0])
  const [task, setTask] = useState<'file' | 'benchmark'>('file'), [fileStatus, setFileStatus] = useState('Loading local erasure codec…'), [downloadUrl, setDownloadUrl] = useState<string | null>(null)
  const [fileProgress, setFileProgress] = useState({ blocks: 0, totalBlocks: 0, receivedBytes: 0, totalBytes: 0, verifiedBytes: 0, elapsedSeconds: 0 })
  const [speakerStatus, setSpeakerStatus] = useState('Speaker feedback off'), [audioPacketsSent, setAudioPacketsSent] = useState(0)
  const [opticalLink, setOpticalLink] = useState<'searching' | 'aligned' | 'interrupted'>('searching')
  const [recommendedPace, setRecommendedPace] = useState(0)
  const [cameraActive, setCameraActive] = useState(true)
  const [diskStorage, setDiskStorage] = useState<StorageMode>('checking')
  const [storageProblem, setStorageProblem] = useState('')
  const diskStorageRef = useRef<StorageMode>('checking')
  const [status, setStatus] = useState({ camera: 'starting', finder: 'searching', reason: 'starting', frame: -1, valid: 0, failed: 0, unique: 0, processingFps: 0, validFps: 0, usefulKBps: 0, decodeMs: 0, acquireMs: 0, drawMs: 0, readMs: 0, sampleMs: 0, crcMs: 0, pixelPath: 'starting', gpuDiagnostic: 'not tested', pixelsPerCell: 0, confidence: 0, deterministic: false, boundary: 'searching', fileSymbols: 0, invalidSymbols: 0, sessionRejects: 0, manifestShards: 0, lastFileBlock: -1 })
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
  const stopSpeaker = () => { if (speakerTimer.current !== null) window.clearInterval(speakerTimer.current); speakerTimer.current = null; if (completionStopTimer.current !== null) window.clearTimeout(completionStopTimer.current); completionStopTimer.current = null; void speaker.current?.close(); speaker.current = null; nextAudioStart.current = 0; setSpeakerStatus('Speaker feedback off') }
  useEffect(() => () => stopSpeaker(), [])
  const sendAcousticStatus = () => {
    const context = speaker.current, state = fileState.current, manifest = state.manifest
    if (!context) return
    // Do not queue stale block bitmaps behind an in-flight tone. The next
    // periodic packet will contain the newest stored-block set. Completion is
    // allowed one slot after the current tone so the sender can stop promptly.
    if (!verified.current && nextAudioStart.current > context.currentTime + 0.2) return
    let type: ControlType, payload: Uint8Array, compact = false
    const transferId = connectionMode === 'audio' ? audioSessionId : state.id
    if (transferId === null) return
    if (verified.current) { type = ControlType.TRANSFER_COMPLETE; payload = new Uint8Array(); compact = connectionMode === 'audio' }
    else if (connectionMode === 'audio' && opticalLost.current) { type = ControlType.PAUSE; payload = Uint8Array.of(opticalProfileNumber(profile), (pacingCode.current << 4) | PROTOCOL_VERSION) }
    else if (connectionMode === 'audio' && resumeRepeats.current > 0) { type = ControlType.RESUME; payload = Uint8Array.of(opticalProfileNumber(profile), (pacingCode.current << 4) | PROTOCOL_VERSION); resumeRepeats.current -= 1 }
    else if (connectionMode === 'audio' && calibrationMode.current === 'selected') { type = ControlType.CALIBRATION_SELECTED; payload = Uint8Array.of(opticalProfileNumber(profile), PROTOCOL_VERSION, selectedPaceCode.current, 0); compact = true }
    else if (connectionMode === 'audio' && alignmentSeen.current && calibrationMode.current !== 'transferring') { type = ControlType.PROFILE_SELECTED; payload = Uint8Array.of(opticalProfileNumber(profile), (pacingCode.current << 4) | PROTOCOL_VERSION) }
    else if (connectionMode === 'audio' && !manifest && calibrationMode.current === 'transferring') { type = ControlType.BLOCK_STATUS; payload = makeCompactStatusPayload(0, 0, pacingCode.current); compact = true }
    else if (connectionMode === 'audio' && !manifest) { type = ControlType.HELLO; payload = Uint8Array.of(diskStorageRef.current === 'opfs' || diskStorageRef.current === 'indexeddb' ? 1 : 0) }
    else if (!manifest) return
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
    const packet = { type, transferId, sequence: audioSequence.current++ & 0xffff, payload }
    const samples = compact ? encodeCompactFskPacket(packet, context.sampleRate) : encodeFskPacket(packet, context.sampleRate)
    const buffer = context.createBuffer(1, samples.length, context.sampleRate)
    buffer.copyToChannel(samples, 0)
    const source = context.createBufferSource(); source.buffer = buffer; source.connect(context.destination)
    const start = Math.max(context.currentTime, nextAudioStart.current)
    source.start(start)
    nextAudioStart.current = start + buffer.duration + 0.1
    setAudioPacketsSent(value => value + 1)
    setSpeakerStatus(type === ControlType.HELLO ? `Sending audio HELLO · session ${transferId.toString(16).padStart(8, '0')}` : type === ControlType.PROFILE_SELECTED ? 'Camera aligned · requesting optical calibration' : type === ControlType.CALIBRATION_SELECTED ? `Calibration selected ${opticalPaceFps(selectedPaceCode.current)} FPS · sending over sound` : type === ControlType.PAUSE ? 'Optical link lost · sending PAUSE over sound' : type === ControlType.RESUME ? 'Optical link reacquired · sending RESUME over sound' : type === ControlType.TRANSFER_COMPLETE ? 'Sending verified-complete tone' : type === ControlType.READY ? 'Optical manifest confirmed; sending compact READY' : compact ? 'Sending compact cumulative block ACK' : 'Sending block bitmap over speaker')
    if (type === ControlType.TRANSFER_COMPLETE && ++completeSignalsSent.current >= 3) {
      if (speakerTimer.current !== null) window.clearInterval(speakerTimer.current)
      speakerTimer.current = null
      completionStopTimer.current = window.setTimeout(() => { stopSpeaker(); setSpeakerStatus('Verified completion sent · speaker off') }, Math.ceil((nextAudioStart.current - context.currentTime) * 1000) + 150)
    }
  }
  const startSpeaker = async () => {
    if (speaker.current) return
    try { const context = new AudioContext(); speaker.current = context; await context.resume(); setSpeakerStatus(connectionMode === 'audio' ? 'Sending audio pairing handshake' : 'Speaker ready; awaiting recovered blocks'); sendAcousticStatus(); speakerTimer.current = window.setInterval(sendAcousticStatus, connectionMode === 'audio' ? 2200 : 4400) }
    catch { stopSpeaker(); setSpeakerStatus('Could not start speaker feedback') }
  }
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
  const resetFile = () => { stopSpeaker(); void fileState.current.sink?.remove(); fileState.current = emptyFileState(); fileDecodeStats.current = { symbols: 0, invalidSymbols: 0, sessionRejects: 0, manifestShards: 0, lastBlock: -1 }; verified.current = false; readySent.current = false; alignmentSeen.current = false; opticalLost.current = false; lastOpticalAt.current = 0; resumeRepeats.current = 0; pacingCode.current = 0; selectedPaceCode.current = 0; calibrationMode.current = 'idle'; calibrationSamples.current.clear(); setRecommendedPace(0); setOpticalLink('searching'); completeSignalsSent.current = 0; fileStarted.current = 0; setAudioSessionId(crypto.getRandomValues(new Uint32Array(1))[0]); setCameraActive(true); setFileProgress({ blocks: 0, totalBlocks: 0, receivedBytes: 0, totalBytes: 0, verifiedBytes: 0, elapsedSeconds: 0 }); if (downloadUrl) URL.revokeObjectURL(downloadUrl); setDownloadUrl(null); setFileStatus('Waiting for optical ZIP symbols') }
  const markStored = (state: FileReceiveState, blockId: number) => {
    if (fileState.current !== state || state.received.has(blockId)) return
    const manifest = state.manifest
    if (!manifest) return
    state.received.add(blockId)
    const blockLength = Math.min(manifest.blockBytes, TRANSFER_MANIFEST_BYTES + manifest.archiveBytes - blockId * manifest.blockBytes)
    state.receivedBytes += Math.max(0, blockLength - (blockId === 0 ? TRANSFER_MANIFEST_BYTES : 0))
    setFileStatus(`Stored ${state.received.size} of ${manifest.totalBlocks} blocks · transfer ${state.id!.toString(16).padStart(8, '0')}`)
    setFileProgress(previous => ({ ...previous, blocks: state.received.size, totalBlocks: manifest.totalBlocks, receivedBytes: state.receivedBytes, totalBytes: manifest.archiveBytes, elapsedSeconds: fileStarted.current ? (performance.now() - fileStarted.current) / 1000 : 0 }))
    sendAcousticStatus()
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
      verified.current = true
      setCameraActive(false)
      const grid = gridRef.current
      grid?.getContext('2d')?.clearRect(0, 0, grid.width, grid.height)
      sendAcousticStatus()
      setFileProgress(previous => ({ ...previous, verifiedBytes: archive.size, elapsedSeconds: fileStarted.current ? (performance.now() - fileStarted.current) / 1000 : 0 }))
      setFileStatus(`TRANSFER VERIFIED · ${archive.size.toLocaleString()} ZIP bytes · SHA-256 checked in ${((performance.now() - verificationStarted) / 1000).toFixed(1)} s`)
    })().catch(error => { if (fileState.current === state) setFileStatus(error instanceof Error ? error.message : 'Could not verify optical archive') })
  }
  const acceptFileFrame = (result: OpticalImageDecode) => {
    if (!recoveryCodec.current || !result.ok) return
    const symbol = unpackOpticalSymbol(result.payload)
    if (!symbol || symbol.blockId !== result.header.blockId) { fileDecodeStats.current.invalidSymbols += 1; return }
    const state = fileState.current
    if (connectionMode === 'audio' && symbol.transferId !== audioSessionId) { fileDecodeStats.current.sessionRejects += 1; return }
    if (connectionMode === 'audio' && (result.header.profileId !== opticalProfileNumber(profile) || result.header.version !== PROTOCOL_VERSION)) { fileDecodeStats.current.invalidSymbols += 1; return }
    if (connectionMode === 'audio') {
      const calibration = readCalibrationFrameId(result.header.frameId)
      if (opticalLost.current && !calibration && result.header.frameId === 0 && calibrationMode.current !== 'transferring') { calibrationMode.current = 'idle'; selectedPaceCode.current = 0; calibrationSamples.current.clear() }
      if (calibration?.stage === CALIBRATION_END_STAGE && calibrationMode.current !== 'selected' && calibrationMode.current !== 'transferring') {
        const samples = new Map<number, { firstSequence: number; lastSequence: number; uniqueFrames: number; spanMs: number }>()
        for (const [stage, item] of calibrationSamples.current) samples.set(stage, { firstSequence: item.firstSequence, lastSequence: item.lastSequence, uniqueFrames: item.seen.size, spanMs: item.lastAt - item.firstAt })
        const code = selectCalibratedPaceCode(profile, samples)
        selectedPaceCode.current = code; pacingCode.current = code; setRecommendedPace(opticalPaceFps(code))
        calibrationMode.current = 'selected'
        setFileStatus(`Optical calibration complete: ${opticalPaceFps(code)} logical FPS. Sending selection over sound…`)
      } else if (calibration && calibration.stage < calibrationRates(profile).length && calibrationMode.current !== 'selected' && calibrationMode.current !== 'transferring') {
        calibrationMode.current = 'probing'
        const now = performance.now()
        let sample = calibrationSamples.current.get(calibration.stage)
        if (!sample) { sample = { firstSequence: calibration.sequence, lastSequence: calibration.sequence, seen: new Set<number>(), firstAt: now, lastAt: now }; calibrationSamples.current.set(calibration.stage, sample) }
        if (!sample.seen.has(calibration.sequence)) { sample.seen.add(calibration.sequence); sample.firstSequence = Math.min(sample.firstSequence, calibration.sequence); sample.lastSequence = Math.max(sample.lastSequence, calibration.sequence); sample.lastAt = now }
      } else if (!calibration && result.header.frameId > 0) calibrationMode.current = 'transferring'
      lastOpticalAt.current = performance.now()
      if (!alignmentSeen.current) { alignmentSeen.current = true; setOpticalLink('aligned'); sendAcousticStatus() }
      else if (opticalLost.current) { opticalLost.current = false; resumeRepeats.current = 1; setOpticalLink('aligned'); sendAcousticStatus() }
      else if (calibrationMode.current === 'selected') sendAcousticStatus()
    }
    fileDecodeStats.current.symbols += 1
    fileDecodeStats.current.lastBlock = symbol.blockId
    if (state.id === null) state.id = symbol.transferId
    if (!fileStarted.current && result.header.frameId > 0 && !readCalibrationFrameId(result.header.frameId)) fileStarted.current = performance.now()
    if (symbol.transferId !== state.id || state.received.has(symbol.blockId) || state.blocks.has(symbol.blockId) || state.verifying || state.storageError) return
    if (state.manifest && symbol.blockId >= state.manifest.totalBlocks) return
    let collector = state.collectors.get(symbol.blockId)
    if (!collector) {
      if (state.collectors.size >= 64) state.collectors.delete(state.collectors.keys().next().value!)
      collector = new OpticalBlockCollector(recoveryCodec.current, symbol.transferId, symbol.blockId); state.collectors.set(symbol.blockId, collector)
    }
    const block = collector.add(symbol)
    if (symbol.blockId === 0) fileDecodeStats.current.manifestShards = collector.count
    if (!block) return
    state.blocks.set(symbol.blockId, block); state.collectors.delete(symbol.blockId)
    if (symbol.blockId === 0) {
      const manifest = unpackTransferManifest(block)
      if (!manifest || manifest.transferId !== state.id) { state.storageError = true; setFileStatus('Invalid optical manifest'); return }
      state.manifest = manifest
      setFileProgress(previous => ({ ...previous, totalBlocks: manifest.totalBlocks, totalBytes: manifest.archiveBytes }))
      state.sinkOpening = true
      void (async (): Promise<OpticalSink> => {
        if (diskStorageRef.current === 'opfs') {
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
    let cancelled = false, stream: MediaStream | undefined, animation = 0, busy = false, lastCapture = 0
    const worker = new Worker(new URL('./optical-worker.ts', import.meta.url), { type: 'module' })
    workerRef.current = worker
    const history: Array<{ at: number; bytes: number; valid: boolean }> = []
    const seen = new Set<number>()
    let valid = 0, failed = 0, processed = 0, lastUi = 0
    worker.onmessage = (event: MessageEvent<{ result: OpticalImageDecode; finderStage: string; decodeMs: number; acquireMs: number; drawMs: number; readMs: number; sampleMs: number; crcMs: number; pixelPath: string; gpuDiagnostic: string }>) => {
      busy = false
      const now = performance.now(), result = event.data.result
      processed += 1
      if (task === 'file') acceptFileFrame(result)
      if (result.ok) valid += 1; else failed += 1
      let uniqueBytes = 0
      if (result.ok && !seen.has(result.header.frameId)) { seen.add(result.header.frameId); uniqueBytes = result.payload.length }
      history.push({ at: now, bytes: uniqueBytes, valid: result.ok })
      while (history.length && now - history[0].at > 5000) history.shift()
      if (task === 'file' && connectionMode === 'audio' && calibrationMode.current === 'transferring' && history.length >= 4 && now - history[0].at >= 1000) {
        const span = (now - history[0].at) / 1000
        const processedFps = (history.length - 1) / span
        const validFps = history.filter(item => item.valid).length / span
        // Ordinary block feedback can restore a pace proven during startup,
        // but a faster pace needs a fresh optical probe. Repeated decodes of
        // one held frame are not evidence that the camera can follow it.
        const code = Math.min(recommendOpticalPaceCode(profile, processedFps, validFps), selectedPaceCode.current)
        if (code !== pacingCode.current) { pacingCode.current = code; setRecommendedPace(opticalPaceFps(code)) }
      }
      if (result.sampledCells && gridRef.current) {
        const canvas = gridRef.current, dimensions = frameDimensions(profile)
        canvas.width = dimensions.width; canvas.height = dimensions.height
        const context = canvas.getContext('2d')
        if (context) { const image = context.createImageData(canvas.width, canvas.height); for (let index = 0; index < result.sampledCells.length; index += 1) { const level = result.sampledCells[index] * (profile.bitsPerSymbol === 2 ? 85 : 255), offset = index * 4; image.data[offset] = level; image.data[offset + 1] = level; image.data[offset + 2] = level; image.data[offset + 3] = 255 } context.putImageData(image, 0, 0) }
      }
      if (now - lastUi > 250) {
        lastUi = now
        const boundary = result.boundary
        const dimensions = frameDimensions(profile)
        const pixelsPerCell = boundary ? Math.min(Math.hypot(boundary.topRight.x - boundary.topLeft.x, boundary.topRight.y - boundary.topLeft.y) / dimensions.width, Math.hypot(boundary.bottomLeft.x - boundary.topLeft.x, boundary.bottomLeft.y - boundary.topLeft.y) / dimensions.height) : 0
        setStatus({ camera: `${video.videoWidth} × ${video.videoHeight}`, finder: event.data.finderStage, reason: result.ok ? 'CRC-valid optical frame' : result.reason, frame: result.ok ? result.header.frameId : -1, valid, failed, unique: seen.size, processingFps: history.length / 5, validFps: history.filter(item => item.valid).length / 5, usefulKBps: history.reduce((sum, item) => sum + item.bytes, 0) / 5120, decodeMs: event.data.decodeMs, acquireMs: event.data.acquireMs, drawMs: event.data.drawMs, readMs: event.data.readMs, sampleMs: event.data.sampleMs, crcMs: event.data.crcMs, pixelPath: event.data.pixelPath, gpuDiagnostic: event.data.gpuDiagnostic, pixelsPerCell, confidence: result.symbolConfidence || 0, deterministic: result.ok && isDeterministicPayload(result.payload, result.header.frameId), boundary: boundary ? `${Math.round(boundary.topLeft.x)},${Math.round(boundary.topLeft.y)} → ${Math.round(boundary.bottomRight.x)},${Math.round(boundary.bottomRight.y)}` : 'searching', fileSymbols: fileDecodeStats.current.symbols, invalidSymbols: fileDecodeStats.current.invalidSymbols, sessionRejects: fileDecodeStats.current.sessionRejects, manifestShards: fileDecodeStats.current.manifestShards, lastFileBlock: fileDecodeStats.current.lastBlock })
      }
    }
    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60 } } })
        if (cancelled) { stream.getTracks().forEach(track => track.stop()); return }
        video.srcObject = stream; await video.play()
        if (cancelled) { stream.getTracks().forEach(track => track.stop()); video.srcObject = null; return }
        const capture = (now: number) => {
          if (cancelled) return
          if (!busy && video.videoWidth && now - lastCapture >= 1000 / profile.expectedCameraFps) {
            busy = true; lastCapture = now
            void createImageBitmap(video).then(bitmap => { if (cancelled) { bitmap.close(); return } worker.postMessage({ bitmap, profileId: profile.id, sentAt: now }, [bitmap]) }).catch(() => { busy = false; setStatus(previous => ({ ...previous, reason: 'Camera frame capture failed' })) })
          }
          animation = requestAnimationFrame(capture)
        }
        animation = requestAnimationFrame(capture)
      } catch { setStatus(previous => ({ ...previous, reason: 'Camera permission or worker unavailable' })) }
    })()
    return () => { cancelled = true; cancelAnimationFrame(animation); stream?.getTracks().forEach(track => track.stop()); video.pause(); video.srcObject = null; worker.terminate(); workerRef.current = null }
  }, [profile, task, connectionMode, audioSessionId, cameraActive])
  useEffect(() => {
    if (cameraActive) return
    const grid = gridRef.current
    grid?.getContext('2d')?.clearRect(0, 0, grid.width, grid.height)
  }, [cameraActive])
  const exportMetrics = () => {
    const content = JSON.stringify({ kind: 'physical-optical-diagnostics', timestamp: new Date().toISOString(), profile: profile.id, task, ...status, fileProgress, speakerStatus }, null, 2)
    const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }))
    const link = document.createElement('a'); link.href = url; link.download = 'optical-diagnostics.json'; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return <main style={{ maxWidth: 1180, margin: '28px auto', padding: 20, fontFamily: 'system-ui, sans-serif' }}>
    <h1>High-Speed Optical</h1>
    <p>Local camera decoding in a worker. Match the sender profile. Archive bytes never enter a network API.</p>
    <nav><button onClick={() => { resetFile(); setTask('file') }}>Receive files</button> <button onClick={() => { resetFile(); setTask('benchmark') }}>Link benchmark</button></nav>
    {task === 'file' && <label>Connection <select value={connectionMode} disabled={!!speaker.current || !!fileState.current.manifest} onChange={event => { resetFile(); setConnectionMode(event.target.value as ConnectionMode); setAudioPacketsSent(0) }}><option value="direct">Direct optical (existing)</option><option value="audio">Audio pairing + ACK</option></select></label>}
    <label>Optical profile <select value={profile.id} onChange={event => { resetFile(); setProfile(OPTICAL_PROFILES.find(item => item.id === event.target.value) || DEBUG_PROFILE) }}>{OPTICAL_PROFILES.map(item => <option key={item.id} value={item.id}>{item.gridWidth}×{item.gridHeight} / {item.bitsPerSymbol === 2 ? '4-level (experimental)' : 'binary'}</option>)}</select></label>
    <button onClick={() => workerRef.current?.postMessage({ reset: true, profileId: profile.id })}>Re-detect boundary</button>
    <button onClick={exportMetrics}>Export metrics JSON</button>
    {task === 'file' && <><button onClick={() => void startSpeaker()} disabled={!!speaker.current || verified.current || (connectionMode === 'audio' && diskStorage === 'checking')}>{connectionMode === 'audio' ? 'Start audio handshake + feedback' : 'Enable speaker feedback'}</button><p>{speakerStatus} · {audioPacketsSent} control packets sent{connectionMode === 'audio' && ` · session ${audioSessionId.toString(16).padStart(8, '0')} · optical link ${opticalLink} · recommended optical pace ${recommendedPace || 'measuring'} FPS`}</p><p>{fileStatus} {downloadUrl && <a href={downloadUrl} download="optical-transfer.zip">Download verified ZIP</a>}</p>{!cameraActive && <p>Camera off after verified transfer. Select Receive files to start another.</p>}</>}
    {task === 'file' && <p>Local ZIP storage: {diskStorage === 'checking' ? 'checking…' : diskStorage === 'opfs' ? 'browser-private file system' : diskStorage === 'indexeddb' ? 'IndexedDB blocks' : 'memory only'}</p>}
    {task === 'file' && diskStorage === 'memory' && <p role="alert">This browser has no writable local storage for large ZIPs. It can receive up to 16 MiB in memory. Use a normal browser window with IndexedDB or browser-private file storage for larger transfers. {storageProblem}</p>}
    {task === 'file' && fileProgress.totalBytes === 0 && <p>0 ZIP bytes received · {status.sessionRejects > 0 ? 'optical frames belong to a different audio session; re-pair the sender' : status.manifestShards > 0 ? `waiting for transfer manifest (${status.manifestShards} of 8 distinct symbols)` : 'waiting for transfer manifest'}</p>}
    {task === 'file' && fileProgress.totalBytes > 0 && <div style={{ margin: '16px 0' }}><p><strong>{fileProgress.receivedBytes.toLocaleString()} / {fileProgress.totalBytes.toLocaleString()} ZIP bytes received ({(100 * fileProgress.receivedBytes / fileProgress.totalBytes).toFixed(1)}%)</strong></p><progress aria-label="ZIP bytes received" value={fileProgress.receivedBytes} max={fileProgress.totalBytes} style={{ width: '100%', height: 20 }} /><p>Blocks {fileProgress.blocks} / {fileProgress.totalBlocks} · average {(fileProgress.receivedBytes / Math.max(0.001, fileProgress.elapsedSeconds) / 1e6).toFixed(3)} MB/s · {fileProgress.verifiedBytes ? 'SHA-256 verified' : fileProgress.blocks < fileProgress.totalBlocks ? 'receiving missing blocks; SHA-256 starts when all are stored' : 'all blocks stored; checking local SHA-256'}</p></div>}
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 320px', gap: 20, marginTop: 16 }}>
      <video ref={videoRef} muted playsInline style={{ width: '100%', background: '#111' }} />
      <aside><h2>Diagnostics</h2><p>{status.reason}</p><dl><dt>Camera</dt><dd>{status.camera}</dd><dt>Finder</dt><dd>{status.finder}</dd><dt>Detected boundary</dt><dd>{status.boundary}</dd><dt>Camera pixels / cell</dt><dd>{status.pixelsPerCell ? `${status.pixelsPerCell.toFixed(1)}${status.pixelsPerCell < 6 ? ' · move camera closer' : ''}` : '—'}</dd><dt>Frame</dt><dd>{status.frame < 0 ? '—' : status.frame}</dd><dt>Processed / valid FPS</dt><dd>{status.processingFps.toFixed(1)} / {status.validFps.toFixed(1)}</dd><dt>Decode time</dt><dd>{status.decodeMs.toFixed(1)} ms</dd><dt>Pixel path</dt><dd>{status.pixelPath}</dd><dt>GPU candidate</dt><dd>{status.gpuDiagnostic}</dd><dt>Stages</dt><dd>find {status.acquireMs.toFixed(0)} · draw {status.drawMs.toFixed(0)} · read {status.readMs.toFixed(0)} · sample {status.sampleMs.toFixed(0)} · CRC {status.crcMs.toFixed(0)} ms</dd><dt>Unique optical bytes</dt><dd>{status.usefulKBps.toFixed(1)} KB/s</dd><dt>Valid / failed</dt><dd>{status.valid} / {status.failed}</dd><dt>Unique frames</dt><dd>{status.unique}</dd>{task === 'file' && <><dt>File symbols decoded</dt><dd>{status.fileSymbols}</dd><dt>Wrong audio session</dt><dd>{status.sessionRejects}</dd><dt>Invalid file symbols</dt><dd>{status.invalidSymbols}</dd><dt>Manifest shards</dt><dd>{status.manifestShards} / 8</dd><dt>Last file block</dt><dd>{status.lastFileBlock < 0 ? '—' : status.lastFileBlock}</dd></>}<dt>Symbol confidence</dt><dd>{(status.confidence * 100).toFixed(0)}%</dd>{task === 'benchmark' && <><dt>Benchmark payload</dt><dd>{status.deterministic ? 'verified' : '—'}</dd></>}</dl><canvas ref={gridRef} aria-label="Sampled optical grid" style={{ width: '100%', imageRendering: 'pixelated', border: '1px solid #777' }} /></aside>
    </div>
  </main>
}
