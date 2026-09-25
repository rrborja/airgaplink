import { useEffect, useMemo, useRef, useState } from 'react'
import JSZip from 'jszip'
import { prepareZXingModule, writeBarcode, type BarcodeSymbol } from 'zxing-wasm/writer'
import writerWasmUrl from 'zxing-wasm/writer/zxing_writer.wasm?url'
import { DEBUG_PROFILE, OPTICAL_PROFILES, TransportMode, deterministicPayload, encodeOpticalFrame, framePayloadCapacity, type OpticalProfile, type TransportMode as TransportModeValue } from '@qrcopy/optical-core'
import { OpticalRenderer, scheduleOpticalFrames } from './OpticalRenderer'
import { OpticalFileSender } from './OpticalFileSender'

const SENDER_API_URL = import.meta.env.VITE_SENDER_API_URL || ''
const QR_CHUNK_BYTES = 512
const FEC_GROUP_SIZE = 8
const QR_PER_TICK = 4
const TICK_MS = 125 // 4 codes × 8 updates/sec = 32 QR frames/sec
const HEADER_BYTES = 38

interface Range { start: number; end: number }
interface LocalTransfer { archive: Uint8Array; chunks: Uint8Array[]; parity: Map<number, Uint8Array> }
interface TransferStatus { transferId: string; receiverSessionId: string; totalChunks: number; receivedRanges: Range[]; missingRanges: Range[]; completed: boolean }
interface FrameSpec { kind: 0 | 1; index: number }
interface RenderedFrame { key: string; symbol: BarcodeSymbol }

function codeBytes(code: string) { return new TextEncoder().encode(code) }
function xorInto(target: Uint8Array, source: Uint8Array) { for (let index = 0; index < target.length; index += 1) target[index] ^= source[index] || 0 }
function buildParity(chunks: Uint8Array[], group: number, cache: Map<number, Uint8Array>) {
  const existing = cache.get(group); if (existing) return existing
  const parity = new Uint8Array(QR_CHUNK_BYTES)
  for (let index = group * FEC_GROUP_SIZE; index < Math.min(chunks.length, (group + 1) * FEC_GROUP_SIZE); index += 1) xorInto(parity, chunks[index])
  cache.set(group, parity); return parity
}
function frameBytes(spec: FrameSpec, local: LocalTransfer, transfer: TransferStatus) {
  const payload = spec.kind === 0 ? local.chunks[spec.index] : buildParity(local.chunks, spec.index, local.parity)
  const bytes = new Uint8Array(HEADER_BYTES + payload.length), view = new DataView(bytes.buffer)
  bytes.set(codeBytes('QRC2'), 0); bytes[4] = 1; bytes[5] = spec.kind
  bytes.set(codeBytes(transfer.receiverSessionId), 6); bytes.set(codeBytes(transfer.transferId), 14)
  view.setUint32(22, transfer.totalChunks); view.setUint32(26, spec.index); view.setUint32(30, local.archive.length); view.setUint16(34, QR_CHUNK_BYTES); view.setUint16(36, payload.length)
  bytes.set(payload, HEADER_BYTES); return bytes
}
function rangeCount(ranges: Range[]) { return ranges.reduce((count, range) => count + range.end - range.start + 1, 0) }
function rangeAt(ranges: Range[], offset: number) { for (const range of ranges) { const length = range.end - range.start + 1; if (offset < length) return range.start + offset; offset -= length } return 0 }
function missingFromReceived(received: Range[], total: number) {
  const completedGroups = new Set<number>(); for (const range of received) for (let group = range.start; group <= range.end; group += 1) completedGroups.add(group)
  const missing: Range[] = [], groupCount = Math.ceil(total / FEC_GROUP_SIZE)
  for (let group = 0; group < groupCount; group += 1) if (!completedGroups.has(group)) missing.push({ start: group * FEC_GROUP_SIZE, end: Math.min(total - 1, (group + 1) * FEC_GROUP_SIZE - 1) })
  return missing
}

function QrCanvas({ frame }: { frame: RenderedFrame }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current; if (!canvas) return
    canvas.width = frame.symbol.width; canvas.height = frame.symbol.height
    const context = canvas.getContext('2d'); if (!context) return
    const image = context.createImageData(frame.symbol.width, frame.symbol.height)
    for (let index = 0; index < frame.symbol.data.length; index += 1) { const value = frame.symbol.data[index]; image.data[index * 4] = value; image.data[index * 4 + 1] = value; image.data[index * 4 + 2] = value; image.data[index * 4 + 3] = 255 }
    context.putImageData(image, 0, 0)
  }, [frame])
  return <canvas ref={ref} style={styles.barcode} aria-label={`QR frame ${frame.key}`} onClick={() => void ref.current?.requestFullscreen()} />
}

function QrCompatibilitySender() {
  const directoryInput = useRef<HTMLInputElement>(null), cursor = useRef(0), dataFrames = useRef(0), lastDataIndex = useRef(0), generating = useRef(false)
  const [files, setFiles] = useState<File[]>([]), [receiverSessionId, setReceiverSessionId] = useState('')
  const [localTransfer, setLocalTransfer] = useState<LocalTransfer | null>(null), [transfer, setTransfer] = useState<TransferStatus | null>(null)
  const [frames, setFrames] = useState<RenderedFrame[]>([]), [ready, setReady] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState<string | null>(null)

  useEffect(() => { directoryInput.current?.setAttribute('webkitdirectory', ''); directoryInput.current?.setAttribute('directory', ''); void prepareZXingModule({ overrides: { locateFile: (path: string) => path.endsWith('.wasm') ? writerWasmUrl : path }, fireImmediately: true }).then(() => setReady(true)).catch(() => setError('Unable to load the QR encoder')) }, [])
  useEffect(() => {
    if (!transfer || transfer.completed) return
    const events = new EventSource(`${SENDER_API_URL}/api/events`, { withCredentials: true })
    const update = (event: MessageEvent<string>) => { try { const incoming = JSON.parse(event.data) as Omit<TransferStatus, 'totalChunks' | 'missingRanges' | 'completed'>; setTransfer(previous => previous ? { ...incoming, totalChunks: previous.totalChunks, missingRanges: missingFromReceived(incoming.receivedRanges, previous.totalChunks), completed: incoming.receivedRanges.length === 1 && incoming.receivedRanges[0].start === 0 && incoming.receivedRanges[0].end === Math.ceil(previous.totalChunks / FEC_GROUP_SIZE) - 1 } : previous); setError(null) } catch { setError('Invalid live transfer update') } }
    events.addEventListener('transfer', update); events.onerror = () => setError('Live control stream disconnected; reconnecting…')
    return () => { events.removeEventListener('transfer', update); events.close() }
  }, [transfer?.transferId, transfer?.completed])

  const missingCount = useMemo(() => transfer ? rangeCount(transfer.missingRanges) : 0, [transfer?.missingRanges])
  useEffect(() => {
    if (!transfer || !localTransfer || transfer.completed || !ready || missingCount === 0) return
    const render = async () => {
      if (generating.current) return; generating.current = true
      try {
        const specs: FrameSpec[] = []
        for (let slot = 0; slot < QR_PER_TICK; slot += 1) {
          if (dataFrames.current === FEC_GROUP_SIZE) {
            specs.push({ kind: 1, index: Math.floor(lastDataIndex.current / FEC_GROUP_SIZE) })
            dataFrames.current = 0
            continue
          }
          const offset = cursor.current++ % missingCount, index = rangeAt(transfer.missingRanges, offset)
          lastDataIndex.current = index; dataFrames.current += 1; specs.push({ kind: 0, index })
        }
        const rendered = await Promise.all(specs.map(async spec => {
          const output = await writeBarcode(frameBytes(spec, localTransfer, transfer), { format: 'QRCode', options: 'ecLevel=L', scale: 8, addQuietZones: true })
          if (output.error) throw new Error(output.error)
          return { key: `${spec.kind}:${spec.index}`, symbol: output.symbol }
        }))
        setFrames(rendered)
      } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to render QR frames') } finally { generating.current = false }
    }
    void render(); const timer = window.setInterval(() => void render(), TICK_MS); return () => window.clearInterval(timer)
  }, [transfer?.transferId, transfer?.missingRanges, transfer?.completed, localTransfer, ready, missingCount])

  const startTransfer = async () => {
    if (!files.length || !receiverSessionId.trim() || !ready) return
    setLoading(true); setError(null)
    try {
      const zip = new JSZip(); for (const file of files) zip.file((file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name, file)
      const archive = new Uint8Array(await (await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' })).arrayBuffer())
      const chunks = Array.from({ length: Math.ceil(archive.length / QR_CHUNK_BYTES) }, (_, index) => archive.slice(index * QR_CHUNK_BYTES, (index + 1) * QR_CHUNK_BYTES))
      const response = await fetch(`${SENDER_API_URL}/api/transfers`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ receiverSessionId: receiverSessionId.trim() }) })
      const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Unable to start transfer')
      cursor.current = 0; dataFrames.current = 0; lastDataIndex.current = 0; setLocalTransfer({ archive, chunks, parity: new Map() }); setTransfer({ ...result, totalChunks: chunks.length, missingRanges: [{ start: 0, end: chunks.length - 1 }], completed: false })
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to create ZIP archive') } finally { setLoading(false) }
  }
  const received = transfer ? transfer.totalChunks - missingCount : 0
  return <main style={styles.container}><h1>QR Directory Sender</h1>{!transfer ? <section style={styles.card}>
    <label style={styles.label}>Receiver session code<input value={receiverSessionId} onChange={event => setReceiverSessionId(event.target.value.toUpperCase())} placeholder="Paste the 8-character code shown on the receiver" style={styles.input} /></label>
    <label style={styles.label}>Directory to transfer<input ref={directoryInput} type="file" multiple onChange={event => { setFiles(Array.from(event.target.files || [])); setError(null) }} style={styles.input} /></label>
    {files.length > 0 && <p>{files.length} files selected. The ZIP stays in this browser; QR frames carry binary bytes directly.</p>}
    <button disabled={loading || !ready || !files.length || !receiverSessionId.trim()} onClick={startTransfer} style={styles.button}>{loading ? 'Creating ZIP…' : ready ? 'Start continuous QR transfer' : 'Loading QR encoder…'}</button>
  </section> : <section style={styles.card}>{transfer.completed ? <p style={styles.complete}>Transfer complete. The receiver can download its ZIP archive.</p> : <>
    <p>Streaming {frames.length} QR codes at up to 32 frames/sec · {Math.ceil(received / FEC_GROUP_SIZE)} FEC groups confirmed</p><div style={styles.grid}>{frames.map(frame => <QrCanvas key={frame.key} frame={frame} />)}</div>
    <p>Frames cycle continuously. Every eighth source frame includes XOR parity; missing ranges reported by the receiver are retransmitted first.</p>
  </>}</section>}{error && <p style={styles.error}>{error}</p>}</main>
}
interface OpticalStats { frameId: number; displayFps: number; rawBytesPerSecond: number; elapsedMs: number; benchmarkBytes: number }

function OpticalHighSpeedSender() {
  const canvasRef = useRef<HTMLCanvasElement>(null), renderer = useRef<OpticalRenderer | null>(null), frameId = useRef(0), startedAt = useRef(0), renderedFrames = useRef(0)
  const [running, setRunning] = useState(true), [rendererReady, setRendererReady] = useState(false), [benchmarkMiB, setBenchmarkMiB] = useState(1), [profile, setProfile] = useState<OpticalProfile>(DEBUG_PROFILE), [stats, setStats] = useState<OpticalStats>({ frameId: 0, displayFps: 0, rawBytesPerSecond: 0, elapsedMs: 0, benchmarkBytes: 1024 * 1024 })
  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return
    renderer.current = new OpticalRenderer(canvas); setRendererReady(true)
    return () => { renderer.current = null; setRendererReady(false) }
  }, [])
  useEffect(() => {
    if (!running || !renderer.current || !rendererReady) return
    frameId.current = 0; renderedFrames.current = 0; startedAt.current = performance.now()
    const payloadBytes = framePayloadCapacity(profile), benchmarkBytes = benchmarkMiB * 1024 * 1024
    const render = () => {
      const id = frameId.current++
      // This benchmark payload exists only in browser memory and becomes pixels.
      // It is intentionally never supplied to fetch, EventSource, or any network API.
      renderer.current?.render(encodeOpticalFrame(deterministicPayload(id, payloadBytes), id, Math.floor((id * payloadBytes) / 65_536), profile))
      renderedFrames.current += 1
      const elapsedMs = performance.now() - startedAt.current
      if (renderedFrames.current === 1 || renderedFrames.current % 8 === 0) setStats({ frameId: id, displayFps: renderedFrames.current / (elapsedMs / 1000), rawBytesPerSecond: payloadBytes * renderedFrames.current / (elapsedMs / 1000), elapsedMs, benchmarkBytes })
    }
    return scheduleOpticalFrames(profile, render)
  }, [running, rendererReady, benchmarkMiB, profile])
  const progress = Math.min(100, stats.elapsedMs === 0 ? 0 : (stats.frameId * framePayloadCapacity(profile)) / stats.benchmarkBytes * 100)
  return <main style={styles.container}>
    <h1>High-Speed Optical — Debug Profile</h1>
    <section style={styles.card}>
      <p>Deterministic benchmark bytes travel through display pixels. Use Transfer files for the ZIP, erasure coding, and acoustic feedback path.</p>
      <div style={styles.controls}><label style={styles.label}>Optical profile<select value={profile.id} onChange={event => setProfile(OPTICAL_PROFILES.find(item => item.id === event.target.value) || DEBUG_PROFILE)} style={styles.input}>{OPTICAL_PROFILES.map(item => <option key={item.id} value={item.id}>{item.gridWidth}×{item.gridHeight} / {item.bitsPerSymbol === 2 ? '4-level (experimental)' : 'binary'}</option>)}</select></label><label style={styles.label}>Benchmark size<select value={benchmarkMiB} onChange={event => setBenchmarkMiB(Number(event.target.value))} style={styles.input}><option value={1}>1 MB</option><option value={10}>10 MB</option><option value={100}>100 MB</option><option value={1024}>1 GB</option></select></label><button onClick={() => setRunning(value => !value)} style={styles.button}>{running ? 'Pause benchmark' : 'Resume benchmark'}</button><button onClick={() => void canvasRef.current?.requestFullscreen()} style={styles.button}>Full screen</button></div>
      <canvas ref={canvasRef} style={styles.opticalCanvas} aria-label="Custom high-speed optical debug frame" />
      <div style={styles.metrics}><span>Profile <strong>{profile.gridWidth}×{profile.gridHeight} / {profile.bitsPerSymbol === 2 ? '4-level' : 'binary'}</strong></span><span>Logical FPS <strong>{stats.displayFps.toFixed(1)}</strong></span><span>Frame <strong>{stats.frameId}</strong></span><span>Raw payload <strong>{(stats.rawBytesPerSecond / 1024).toFixed(1)} KB/s</strong></span></div>
      <div style={styles.progressTrack}><div style={{ ...styles.progressValue, width: `${progress}%` }} /></div><p>{Math.min(stats.frameId * framePayloadCapacity(profile), stats.benchmarkBytes).toLocaleString()} / {stats.benchmarkBytes.toLocaleString()} deterministic bytes cycled</p>
    </section>
  </main>
}

function App() {
  const [mode, setMode] = useState<TransportModeValue>(TransportMode.OPTICAL_HIGH_SPEED)
  const [opticalTask, setOpticalTask] = useState<'file' | 'benchmark'>('file')
  return <><nav style={styles.transportNav} aria-label="Transfer mode"><strong>Transfer Mode</strong><button onClick={() => setMode(TransportMode.OPTICAL_HIGH_SPEED)} style={mode === TransportMode.OPTICAL_HIGH_SPEED ? styles.activeMode : styles.modeButton}>High-Speed Optical</button><button onClick={() => setMode(TransportMode.QR)} style={mode === TransportMode.QR ? styles.activeMode : styles.modeButton}>QR Compatibility Mode</button></nav>{mode === TransportMode.QR ? <QrCompatibilitySender /> : <><nav style={styles.transportNav}><button onClick={() => setOpticalTask('file')} style={opticalTask === 'file' ? styles.activeMode : styles.modeButton}>Transfer files</button><button onClick={() => setOpticalTask('benchmark')} style={opticalTask === 'benchmark' ? styles.activeMode : styles.modeButton}>Link benchmark</button></nav>{opticalTask === 'file' ? <OpticalFileSender /> : <OpticalHighSpeedSender />}</>}</>
}

const styles: Record<string, React.CSSProperties> = { container: { maxWidth: 1160, margin: '32px auto', padding: 20, fontFamily: 'system-ui, sans-serif', textAlign: 'center' }, card: { border: '1px solid #d0d7de', borderRadius: 12, padding: 24, background: '#fff' }, label: { display: 'block', textAlign: 'left', fontWeight: 600, marginBottom: 18 }, input: { boxSizing: 'border-box', display: 'block', width: '100%', marginTop: 6, padding: 10, font: 'inherit' }, button: { padding: '11px 18px', font: 'inherit', background: '#0969da', color: '#fff', border: 0, borderRadius: 6, cursor: 'pointer' }, grid: { display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10, alignItems: 'center' }, barcode: { display: 'block', width: '100%', height: 'auto', background: '#fff', imageRendering: 'pixelated', cursor: 'zoom-in' }, error: { color: '#b42318' }, complete: { color: '#067647', fontWeight: 600 }, transportNav: { display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'center', padding: 14, borderBottom: '1px solid #d0d7de', fontFamily: 'system-ui, sans-serif', flexWrap: 'wrap' }, modeButton: { padding: '8px 12px', border: '1px solid #8c959f', borderRadius: 6, background: '#fff', cursor: 'pointer' }, activeMode: { padding: '8px 12px', border: '1px solid #0969da', borderRadius: 6, background: '#ddf4ff', color: '#0550ae', fontWeight: 700, cursor: 'pointer' }, controls: { display: 'flex', gap: 12, alignItems: 'end', justifyContent: 'center', flexWrap: 'wrap', marginBottom: 16 }, opticalCanvas: { display: 'block', width: '100%', maxHeight: '72vh', objectFit: 'contain', background: '#fff', imageRendering: 'pixelated', margin: '0 auto' }, metrics: { display: 'flex', justifyContent: 'center', gap: 18, flexWrap: 'wrap', marginTop: 14 }, progressTrack: { height: 10, borderRadius: 5, overflow: 'hidden', background: '#d0d7de', marginTop: 18 }, progressValue: { height: '100%', background: '#0969da', transition: 'width 150ms linear' } }
export default App
