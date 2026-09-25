import { useEffect, useRef, useState } from 'react'
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader'
import readerWasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url'
import { DEBUG_PROFILE, TransportMode, decodeOpticalCells, detectOpticalBoundary, frameDimensions, isDeterministicPayload, sampleOpticalCells, type FinderReport, type OpticalBoundary, type OpticalImageDecode, type TransportMode as TransportModeValue } from '@qrcopy/optical-core'
import { WorkerOpticalReceiver } from './WorkerOpticalReceiver'

const RECEIVER_API_URL = import.meta.env.VITE_RECEIVER_API_URL || 'http://localhost:3002'
const HEADER_BYTES = 38
interface SessionStatus { sessionId: string; status: 'waiting' | 'receiving' | 'complete'; receivedChunks: number; totalChunks: number; complete: boolean }

function frameKey(bytes: Uint8Array) { return Array.from(bytes.subarray(0, HEADER_BYTES)).join(',') }

function QrCompatibilityReceiver() {
  const videoRef = useRef<HTMLVideoElement>(null), seenFrames = useRef(new Set<string>()), submitting = useRef(new Set<string>())
  const [session, setSession] = useState<SessionStatus | null>(null), [message, setMessage] = useState('Loading binary QR decoder…'), [cameraReady, setCameraReady] = useState(false)
  const submitFrame = async (bytes: Uint8Array) => {
    if (bytes.length < HEADER_BYTES) return
    const key = frameKey(bytes); if (seenFrames.current.has(key) || submitting.current.has(key)) return
    submitting.current.add(key)
    try {
      const response = await fetch(`${RECEIVER_API_URL}/api/receive`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer })
      const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Receiver rejected QR frame')
      seenFrames.current.add(key)
      setSession(previous => previous ? { ...previous, receivedChunks: result.receivedChunks, totalChunks: result.totalChunks, complete: result.complete, status: result.complete ? 'complete' : 'receiving' } : previous)
      setMessage(result.complete ? 'All chunks received. Your ZIP is ready to download.' : `Receiving continuously: ${result.receivedChunks} of ${result.totalChunks} chunks.`)
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Unable to store QR frame') } finally { submitting.current.delete(key) }
  }
  useEffect(() => { void prepareZXingModule({ overrides: { locateFile: (path: string) => path.endsWith('.wasm') ? readerWasmUrl : path }, fireImmediately: true }).then(async () => {
    const response = await fetch(`${RECEIVER_API_URL}/api/start-session`, { method: 'POST' }); const result = await response.json()
    if (!response.ok) throw new Error(result.error || 'Unable to create receiver session')
    setSession({ ...result, status: 'waiting', receivedChunks: 0, totalChunks: 0, complete: false }); setMessage('Share this 8-character session code with the sender, then scan its QR grid.')
  }).catch(error => setMessage(error instanceof Error ? error.message : 'Unable to initialize binary QR decoder')) }, [])
  useEffect(() => {
    if (!session || session.complete || !videoRef.current) return
    let cancelled = false, stream: MediaStream | undefined, decoding = false, lastScan = 0
    const video = videoRef.current, canvas = document.createElement('canvas'), context = canvas.getContext('2d', { willReadFrequently: true })
    void (async () => { try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } })
      if (cancelled) { stream.getTracks().forEach(track => track.stop()); return }
      video.srcObject = stream; await video.play(); if (cancelled) { stream.getTracks().forEach(track => track.stop()); video.srcObject = null; return }; setCameraReady(true); setMessage('Scanning up to four binary QR codes per frame…')
      const scan = async (now: number) => {
        if (cancelled) return
        if (!decoding && now - lastScan >= 50 && video.videoWidth && context) {
          decoding = true; lastScan = now; canvas.width = video.videoWidth; canvas.height = video.videoHeight; context.drawImage(video, 0, 0)
          try { const results = await readBarcodes(context.getImageData(0, 0, canvas.width, canvas.height), { formats: ['QRCode'], maxNumberOfSymbols: 4, tryHarder: false, tryDownscale: false }); for (const result of results) if (result.isValid) void submitFrame(result.bytes) } catch { /* next camera frame retries */ } finally { decoding = false }
        }
        requestAnimationFrame(scan)
      }
      requestAnimationFrame(scan)
    } catch { setMessage('Camera permission is required to receive QR frames.') } })()
    return () => { cancelled = true; stream?.getTracks().forEach(track => track.stop()); video.pause(); video.srcObject = null }
  }, [session?.sessionId, session?.complete])
  const decodeImage = async (event: React.ChangeEvent<HTMLInputElement>) => { const file = event.target.files?.[0]; if (!file) return; try { const results = await readBarcodes(file, { formats: ['QRCode'], maxNumberOfSymbols: 4, tryHarder: true }); for (const result of results) if (result.isValid) await submitFrame(result.bytes) } catch { setMessage('The selected image does not contain a readable binary QR frame.') } finally { event.target.value = '' } }
  const archiveUrl = session?.complete ? `${RECEIVER_API_URL}/api/session/${session.sessionId}/archive` : null
  return <main style={styles.container}><h1>QR Directory Receiver</h1>{session && <section style={styles.session}><strong>Receiver session code</strong><code>{session.sessionId}</code></section>}<p>{message}</p>{session && session.totalChunks > 0 && <p>Received {session.receivedChunks} of {session.totalChunks} chunks</p>}{archiveUrl ? <a href={archiveUrl} style={styles.download}>Download received ZIP</a> : <><video ref={videoRef} muted playsInline style={styles.video} />{!cameraReady && <p>Starting camera…</p>}<label style={styles.imageInput}>Or decode a QR-grid photo<input type="file" accept="image/*" onChange={decodeImage} /></label></>}</main>
}
interface OpticalDiagnostics { cameraFps: number; decodeFps: number; validFrames: number; failures: number; rawBytesPerSecond: number; frameId: number | null; blockId: number | null; reason: string; boundary: OpticalBoundary | null; symbolConfidence: number; deterministic: boolean | null; cameraResolution: string; finderStage: string }

function SampledGrid({ cells }: { cells: Uint8Array | null }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current; if (!canvas || !cells) return
    const { width, height } = frameDimensions(DEBUG_PROFILE)
    canvas.width = width; canvas.height = height
    const context = canvas.getContext('2d'); if (!context) return
    const image = context.createImageData(width, height)
    for (let index = 0; index < cells.length; index += 1) { const value = cells[index] ? 255 : 0, offset = index * 4; image.data[offset] = value; image.data[offset + 1] = value; image.data[offset + 2] = value; image.data[offset + 3] = 255 }
    context.putImageData(image, 0, 0)
  }, [cells])
  return <canvas ref={ref} style={styles.sampleGrid} aria-label="Sampled optical symbol grid" />
}

function OpticalHighSpeedReceiver() {
  const videoRef = useRef<HTMLVideoElement>(null), workCanvas = useRef<HTMLCanvasElement | null>(null), boundary = useRef<OpticalBoundary | undefined>(undefined), lastAcquisition = useRef(0), finderStage = useRef('searching'), samples = useRef<Uint8Array | null>(null)
  const counters = useRef({ started: 0, processed: 0, valid: 0, failures: 0, failureStreak: 0, lastUi: 0, recentValid: [] as number[], recentUnique: [] as Array<{ at: number; bytes: number }>, lastFrameId: null as number | null, lastBlockId: null as number | null, lastUniqueFrameId: null as number | null })
  const [cameraReady, setCameraReady] = useState(false), [diagnostics, setDiagnostics] = useState<OpticalDiagnostics>({ cameraFps: 0, decodeFps: 0, validFrames: 0, failures: 0, rawBytesPerSecond: 0, frameId: null, blockId: null, reason: 'Starting camera…', boundary: null, symbolConfidence: 0, deterministic: null, cameraResolution: '—', finderStage: 'searching' }), [sampleGrid, setSampleGrid] = useState<Uint8Array | null>(null)
  const resetTracking = () => { boundary.current = undefined; lastAcquisition.current = 0; finderStage.current = 'searching'; counters.current.failureStreak = 0; setDiagnostics(previous => ({ ...previous, boundary: null, reason: 'Boundary tracking reset', finderStage: 'searching' })) }
  useEffect(() => {
    const video = videoRef.current; if (!video) return
    let cancelled = false, stream: MediaStream | undefined, busy = false, lastScan = 0
    const publish = (now: number, result?: OpticalImageDecode) => {
      const elapsed = Math.max(1, now - counters.current.started)
      counters.current.recentValid = counters.current.recentValid.filter(at => now - at < 5000)
      counters.current.recentUnique = counters.current.recentUnique.filter(item => now - item.at < 5000)
      const decoded = result?.ok ? result : undefined
      setDiagnostics({ cameraFps: counters.current.processed / (elapsed / 1000), decodeFps: counters.current.recentValid.length / 5, validFrames: counters.current.valid, failures: counters.current.failures, rawBytesPerSecond: counters.current.recentUnique.reduce((sum, item) => sum + item.bytes, 0) / 5, frameId: counters.current.lastFrameId, blockId: counters.current.lastBlockId, reason: decoded ? 'CRC-valid optical frame' : result && !result.ok ? result.reason : 'Searching for finder markers', boundary: result?.boundary || boundary.current || null, symbolConfidence: result?.symbolConfidence || 0, deterministic: decoded ? isDeterministicPayload(decoded.payload, decoded.header.frameId) : null, cameraResolution: `${video.videoWidth} × ${video.videoHeight}`, finderStage: finderStage.current })
      if (result?.sampledCells) { samples.current = result.sampledCells.slice(); setSampleGrid(samples.current) }
    }
    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60 } } })
        video.srcObject = stream; await video.play(); if (cancelled) return
        counters.current.started = performance.now(); setCameraReady(true)
        const scan = (now: number) => {
          if (cancelled) return
          if (!busy && now - lastScan >= 1000 / DEBUG_PROFILE.expectedCameraFps && video.videoWidth > 0) {
            busy = true; lastScan = now
            const scale = Math.min(1, 1280 / video.videoWidth), width = Math.round(video.videoWidth * scale), height = Math.round(video.videoHeight * scale)
            const canvas = workCanvas.current || document.createElement('canvas'); workCanvas.current = canvas
            if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height }
            const context = canvas.getContext('2d', { willReadFrequently: true })
            if (context) {
              context.drawImage(video, 0, 0, width, height)
              const image = context.getImageData(0, 0, width, height)
              if (!boundary.current && now - lastAcquisition.current >= 1000) {
                lastAcquisition.current = now
                // At 640px a screen occupying half the camera view leaves
                // fewer than three pixels per optical cell. Finder acquisition
                // needs the same 1280px image used for payload sampling.
                const report: FinderReport = { stage: 'top-left' }
                const detected = detectOpticalBoundary({ data: image.data, width, height }, DEBUG_PROFILE, report)
                finderStage.current = report.stage
                if (detected) boundary.current = detected
              }
              const sampled = boundary.current && sampleOpticalCells({ data: image.data, width, height }, boundary.current, DEBUG_PROFILE)
              const result: OpticalImageDecode = sampled && boundary.current
                ? { ...decodeOpticalCells(sampled.cells, DEBUG_PROFILE), boundary: boundary.current, sampledCells: sampled.cells, symbolConfidence: sampled.symbolConfidence }
                : { ok: false, reason: 'finder' }
              counters.current.processed += 1
              if (result.boundary) boundary.current = result.boundary
              if (result.ok) {
                counters.current.valid += 1; counters.current.recentValid.push(now); counters.current.failureStreak = 0
                counters.current.lastFrameId = result.header.frameId; counters.current.lastBlockId = result.header.blockId
                if (result.header.frameId !== counters.current.lastUniqueFrameId) {
                  counters.current.lastUniqueFrameId = result.header.frameId
                  counters.current.recentUnique.push({ at: now, bytes: result.payload.length })
                }
              } else { counters.current.failures += 1; counters.current.failureStreak += 1; if (counters.current.failureStreak >= 30) boundary.current = undefined }
              if (now - counters.current.lastUi > 250 || result.ok) { counters.current.lastUi = now; publish(now, result) }
            }
            busy = false
          }
          requestAnimationFrame(scan)
        }
        requestAnimationFrame(scan)
      } catch { setDiagnostics(previous => ({ ...previous, reason: 'Camera permission is required for optical receive mode.' })) }
    })()
    return () => { cancelled = true; stream?.getTracks().forEach(track => track.stop()) }
  }, [])
  return <main style={styles.container}><h1>High-Speed Optical — Debug Receiver</h1><p>This mode performs local camera decoding only. It sends no image data, benchmark data, or file data to an API.</p><section style={styles.opticalLayout}><div><video ref={videoRef} muted playsInline style={styles.video} />{!cameraReady && <p>Starting camera…</p>}<button onClick={resetTracking} style={styles.button}>Re-detect optical boundary</button></div><aside style={styles.diagnostics}><h2>Diagnostics</h2><p><strong>{diagnostics.reason}</strong></p><dl><dt>Camera resolution</dt><dd>{diagnostics.cameraResolution}</dd><dt>Finder stage</dt><dd>{diagnostics.finderStage}</dd><dt>Camera process FPS</dt><dd>{diagnostics.cameraFps.toFixed(1)}</dd><dt>Valid decode FPS</dt><dd>{diagnostics.decodeFps.toFixed(1)}</dd><dt>Frame / block</dt><dd>{diagnostics.frameId ?? '—'} / {diagnostics.blockId ?? '—'}</dd><dt>Raw bytes / sec</dt><dd>{(diagnostics.rawBytesPerSecond / 1024).toFixed(1)} KB/s</dd><dt>Valid / failed</dt><dd>{diagnostics.validFrames} / {diagnostics.failures}</dd><dt>Symbol confidence</dt><dd>{(diagnostics.symbolConfidence * 100).toFixed(0)}%</dd><dt>Benchmark payload</dt><dd>{diagnostics.deterministic === null ? '—' : diagnostics.deterministic ? 'verified' : 'unexpected'}</dd><dt>Detected boundary</dt><dd>{diagnostics.boundary ? `${Math.round(diagnostics.boundary.topLeft.x)},${Math.round(diagnostics.boundary.topLeft.y)} → ${Math.round(diagnostics.boundary.bottomRight.x)},${Math.round(diagnostics.boundary.bottomRight.y)}` : 'searching'}</dd></dl><SampledGrid cells={sampleGrid} /></aside></section></main>
}

function App() {
  const [mode, setMode] = useState<TransportModeValue>(TransportMode.QR)
  return <><nav style={styles.transportNav} aria-label="Transfer mode"><strong>Transfer Mode</strong><button onClick={() => setMode(TransportMode.OPTICAL_HIGH_SPEED)} style={mode === TransportMode.OPTICAL_HIGH_SPEED ? styles.activeMode : styles.modeButton}>High-Speed Optical</button><button onClick={() => setMode(TransportMode.QR)} style={mode === TransportMode.QR ? styles.activeMode : styles.modeButton}>QR Compatibility Mode</button></nav>{mode === TransportMode.QR ? <QrCompatibilityReceiver /> : typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap === 'function' ? <WorkerOpticalReceiver /> : <OpticalHighSpeedReceiver />}</>
}

const styles: Record<string, React.CSSProperties> = { container: { maxWidth: 1120, margin: '40px auto', padding: 20, textAlign: 'center', fontFamily: 'system-ui, sans-serif' }, session: { overflowWrap: 'anywhere', padding: 16, border: '1px solid #0969da', borderRadius: 10, background: '#ddf4ff' }, video: { display: 'block', width: '100%', maxWidth: 800, margin: '20px auto', borderRadius: 10, background: '#111' }, imageInput: { display: 'block', margin: '12px auto', color: '#57606a' }, download: { display: 'inline-block', padding: '12px 18px', color: '#fff', background: '#067647', borderRadius: 6, textDecoration: 'none' }, transportNav: { display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'center', padding: 14, borderBottom: '1px solid #d0d7de', fontFamily: 'system-ui, sans-serif', flexWrap: 'wrap' }, modeButton: { padding: '8px 12px', border: '1px solid #8c959f', borderRadius: 6, background: '#fff', cursor: 'pointer' }, activeMode: { padding: '8px 12px', border: '1px solid #0969da', borderRadius: 6, background: '#ddf4ff', color: '#0550ae', fontWeight: 700, cursor: 'pointer' }, button: { padding: '10px 14px', border: 0, borderRadius: 6, background: '#0969da', color: '#fff', font: 'inherit', cursor: 'pointer' }, opticalLayout: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(280px, 360px)', gap: 20, alignItems: 'start', textAlign: 'left' }, diagnostics: { padding: 18, border: '1px solid #d0d7de', borderRadius: 10, background: '#fff' }, sampleGrid: { width: '100%', imageRendering: 'pixelated', border: '1px solid #8c959f', background: '#fff' } }
export default App
