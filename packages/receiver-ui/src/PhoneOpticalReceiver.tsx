import { useEffect, useRef, useState } from 'react'
import { OPTICAL_PROFILES, opticalProfileNumber, type OpticalProfile } from '@qrcopy/optical-core'
import { CameraFrameMeter } from './camera-telemetry'
import { phoneCameraModes } from './phone-camera-optics'
import { hasPhonePairingHash, parsePhonePairingHash, type PhonePairing } from './phone-pairing'
import { PHONE_CAMERA_FRAME_MAX, PHONE_DECODE_REASONS, decodePhoneRelayMessage, encodePhoneRelayMessage } from './phone-relay-protocol'

const phoneRouteRequested = hasPhonePairingHash(location.hash)
function readPairing(): PhonePairing | null {
  if (phoneRouteRequested) {
    const parsed = parsePhonePairingHash(location.hash)
    if (!parsed) return null
    try { sessionStorage.setItem('airgaplink-phone-pair', JSON.stringify(parsed)) } catch { /* Storage may be unavailable. */ }
    history.replaceState(null, '', location.pathname + location.search)
    return parsed
  }
  try {
    const saved = JSON.parse(sessionStorage.getItem('airgaplink-phone-pair') || 'null') as Partial<PhonePairing> | null
    return saved?.id && saved.token ? parsePhonePairingHash(`#phone=${saved.id}.${saved.token}`) : null
  } catch { return null }
}
const pairing = readPairing()
export function hasPhonePairing() { return phoneRouteRequested || pairing !== null }
function socketUrl() { return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/optical-relay` }

/** The phone captures only. The desktop owns grid decoding and transfer state. */
export function PhoneOpticalReceiver() {
  const videoRef = useRef<HTMLVideoElement>(null), socketRef = useRef<WebSocket | null>(null), connected = useRef(false)
  const cameraStreamRef = useRef<MediaStream | null>(null), peerRef = useRef<RTCPeerConnection | null>(null), rtcActive = useRef(false), forceLossless = useRef(false)
  const pendingCandidates = useRef<RTCIceCandidateInit[]>([])
  const profileRef = useRef<OpticalProfile | null>(null), stopCameraRef = useRef<(() => void) | null>(null), startingCamera = useRef(false)
  const inFlight = useRef<{ sequence: number; at: number } | null>(null), sequence = useRef(0), meter = useRef(new CameraFrameMeter())
  const totals = useRef({ sent: 0, acknowledged: 0, valid: 0, unique: 0, failures: 0, lastFrame: -1, lastReason: 0, previousSent: 0, previousValid: 0, previousUnique: 0, lastAt: 0 })
  const [connection, setConnection] = useState('Connecting to desktop…'), [profile, setProfile] = useState<OpticalProfile | null>(null)
  const [camera, setCamera] = useState('Camera stopped'), [cameraModes, setCameraModes] = useState('Camera modes unavailable until permission is granted')
  const [opticsStatus, setOpticsStatus] = useState('Camera optics not calibrated')
  const [transport, setTransport] = useState('Waiting for camera stream')
  const [metrics, setMetrics] = useState({ cameraFps: 0, sentFps: 0, validFps: 0, uniqueFps: 0, sent: 0, valid: 0, failures: 0, lastReason: 0, resolution: '—' })

  const stopPeer = () => { rtcActive.current = false; peerRef.current?.close(); peerRef.current = null; pendingCandidates.current = [] }
  const startPeer = async () => {
    const stream = cameraStreamRef.current, socket = socketRef.current
    if (!stream || forceLossless.current || !connected.current || !socket || socket.readyState !== WebSocket.OPEN || peerRef.current || typeof RTCPeerConnection === 'undefined') return
    const peer = new RTCPeerConnection({ iceServers: [] })
    peerRef.current = peer
    stream.getVideoTracks().forEach(track => {
      track.contentHint = 'detail'
      const sender = peer.addTrack(track, stream)
      const parameters = sender.getParameters()
      if (parameters.encodings?.length) {
        parameters.encodings[0].maxBitrate = 25_000_000
        parameters.encodings[0].maxFramerate = 60
        void sender.setParameters(parameters).catch(() => { /* Safari may choose its own video bitrate. */ })
      }
    })
    peer.onicecandidate = event => { if (event.candidate && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'webrtc-signal', kind: 'candidate', candidate: event.candidate.toJSON() })) }
    peer.onconnectionstatechange = () => {
      if (peerRef.current !== peer) return
      rtcActive.current = peer.connectionState === 'connected'
      setTransport(rtcActive.current ? 'Live WebRTC camera track · desktop decoding' : peer.connectionState === 'failed' || peer.connectionState === 'closed' ? 'WebRTC unavailable · camera-image fallback' : `WebRTC ${peer.connectionState} · camera-image fallback active`)
      if (peer.connectionState === 'failed') stopPeer()
    }
    try {
      await peer.setLocalDescription(await peer.createOffer())
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'webrtc-signal', kind: 'offer', sdp: peer.localDescription?.sdp }))
    } catch { stopPeer(); setTransport('WebRTC unavailable · camera-image fallback') }
  }

  useEffect(() => {
    if (!pairing) { setConnection('Open the QR pairing link shown on the desktop receiver.'); return }
    let stopped = false, retry: number | null = null, attempts = 0
    const connect = () => {
      if (stopped) return
      const socket = new WebSocket(socketUrl()); socket.binaryType = 'arraybuffer'; socketRef.current = socket
      socket.onopen = () => { attempts = 0; socket.send(JSON.stringify({ type: 'auth', role: 'phone', id: pairing.id, token: pairing.token })); setConnection('Authenticating phone…') }
      socket.onmessage = event => {
        if (typeof event.data === 'string') {
          try {
            const status = JSON.parse(event.data) as { type?: string; connected?: boolean; kind?: string; sdp?: string; candidate?: RTCIceCandidateInit }
            if (status.type === 'authenticated') setConnection('Paired; waiting for desktop receiver…')
            else if (status.type === 'peer') { connected.current = !!status.connected; if (!status.connected) { inFlight.current = null; stopPeer() } else void startPeer(); setConnection(status.connected ? 'Desktop connected · decoding camera frames there' : 'Desktop disconnected; reconnecting when available') }
            else if (status.type === 'webrtc-signal' && status.kind === 'answer' && typeof status.sdp === 'string' && peerRef.current) void peerRef.current.setRemoteDescription({ type: 'answer', sdp: status.sdp }).then(async () => { for (const candidate of pendingCandidates.current.splice(0)) await peerRef.current?.addIceCandidate(candidate).catch(() => {}) }).catch(() => { stopPeer(); setTransport('WebRTC answer rejected · camera-image fallback') })
            else if (status.type === 'webrtc-signal' && status.kind === 'candidate' && status.candidate && peerRef.current) { if (peerRef.current.remoteDescription) void peerRef.current.addIceCandidate(status.candidate).catch(() => {}); else pendingCandidates.current.push(status.candidate) }
          } catch { /* Ignore malformed status. */ }
          return
        }
        const message = decodePhoneRelayMessage(new Uint8Array(event.data as ArrayBuffer))
        if (message?.kind === 'config') {
          const selected = OPTICAL_PROFILES.find(item => opticalProfileNumber(item) === message.profileId) || null
          if (!selected) { setConnection('Desktop selected an unsupported optical profile'); return }
          profileRef.current = selected; setProfile(selected)
          if (selected.id === 'binary-320x180') { forceLossless.current = true; stopPeer(); setTransport('Lossless camera images · dense grid preserved for desktop decoding') }
        } else if (message?.kind === 'camera-path' && message.lossless) {
          forceLossless.current = true; stopPeer(); inFlight.current = null
          setTransport('WebRTC image quality insufficient · switching to lossless camera images')
        } else if (message?.kind === 'camera-ack' && inFlight.current?.sequence === message.sequence) {
          inFlight.current = null
          const current = totals.current
          current.acknowledged += 1; current.lastReason = message.decodeReason
          if (message.valid) { current.valid += 1; if (current.lastFrame !== message.frameId) { current.unique += 1; current.lastFrame = message.frameId } }
          else current.failures += 1
        }
      }
      socket.onclose = event => {
        if (socketRef.current === socket) socketRef.current = null
        connected.current = false; inFlight.current = null; stopPeer()
        if (stopped) return
        if (event.code === 1008) { setConnection('Pairing expired or rejected. Scan a fresh desktop QR code.'); return }
        setConnection('Desktop link interrupted; reconnecting…')
        retry = window.setTimeout(connect, Math.min(10_000, 500 * 2 ** Math.min(attempts++, 5)))
      }
      socket.onerror = () => socket.close()
    }
    connect()
    return () => { stopped = true; if (retry !== null) clearTimeout(retry); stopPeer(); socketRef.current?.close(); socketRef.current = null }
  }, [])

  const startCamera = async () => {
    if (!profileRef.current || !videoRef.current || stopCameraRef.current || startingCamera.current) return
    if (!isSecureContext || !navigator.mediaDevices?.getUserMedia) { setCamera('Camera requires a trusted HTTPS page.'); return }
    startingCamera.current = true
    const dense = profileRef.current.id === 'binary-320x180'
    setCamera('Requesting rear camera for desktop decoding…')
    let stream: MediaStream | null = null
    try {
      for (const rearRequired of [true, false]) {
        for (const mode of phoneCameraModes(dense)) {
          try {
            const candidate = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: rearRequired ? { exact: 'environment' } : { ideal: 'environment' }, width: { ideal: mode.width, max: mode.width }, height: { ideal: mode.height, max: mode.height }, frameRate: { ideal: mode.fps, max: mode.fps } } })
            const actual = candidate.getVideoTracks()[0].getSettings()
            if (dense && actual.width && actual.height && actual.width * actual.height > 4_000_000) { candidate.getTracks().forEach(item => item.stop()); continue }
            stream = candidate; break
          } catch (error) { if (error instanceof DOMException && error.name === 'NotAllowedError') throw error }
        }
        if (stream) break
      }
      if (!stream) throw new Error('No bounded rear-camera mode was accepted')
      const track = stream.getVideoTracks()[0], video = videoRef.current
      video.srcObject = stream; await video.play()
      const capabilities = (typeof track.getCapabilities === 'function' ? track.getCapabilities() : {}) as MediaTrackCapabilities & { zoom?: { min: number; max: number }; focusMode?: string[] }
      if (capabilities.zoom) {
        const normalZoom = Math.max(capabilities.zoom.min, Math.min(1, capabilities.zoom.max))
        try { await track.applyConstraints({ ...track.getConstraints(), advanced: [{ zoom: normalZoom, ...(capabilities.focusMode?.includes('continuous') ? { focusMode: 'continuous' } : {}) }] } as unknown as MediaTrackConstraints) }
        catch { try { await track.applyConstraints({ ...track.getConstraints(), advanced: [{ zoom: normalZoom }] } as unknown as MediaTrackConstraints) } catch { /* Browser-managed optics. */ } }
      } else if (capabilities.focusMode?.includes('continuous')) {
        try { await track.applyConstraints({ ...track.getConstraints(), advanced: [{ focusMode: 'continuous' }] } as unknown as MediaTrackConstraints) } catch { /* Browser-managed focus. */ }
      }
      const settings = track.getSettings()
      cameraStreamRef.current = stream
      if (dense) { forceLossless.current = true; setTransport('Lossless camera images · dense grid preserved for desktop decoding') }
      else void startPeer()
      setCameraModes(`Actual ${settings.width || video.videoWidth}×${settings.height || video.videoHeight} at ${settings.frameRate || '?'} FPS · supported up to ${capabilities.width?.max || '?'}×${capabilities.height?.max || '?'}`)
      setOpticsStatus('Fixed field of view · all four finder corners sent to desktop')
      setCamera('Rear camera active · images sent to desktop')
      const canvas = document.createElement('canvas'), context = canvas.getContext('2d', { alpha: false })
      if (!context) throw new Error('Camera image encoder unavailable')
      let stopped = false, encoding = false, lastCapture = 0, videoCallback: number | null = null, animationCallback: number | null = null, frameCounter = 0
      const capture = (now: number) => {
        const socket = socketRef.current
        if (stopped || rtcActive.current || encoding || !connected.current || !profileRef.current || !video.videoWidth || now - lastCapture < 1000 / 15 || !socket || socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 128 * 1024) return
        if (inFlight.current && now - inFlight.current.at < 2500) return
        inFlight.current = null; encoding = true; lastCapture = now
        if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) { canvas.width = video.videoWidth; canvas.height = video.videoHeight }
        context.drawImage(video, 0, 0, canvas.width, canvas.height)
        canvas.toBlob(blob => {
          if (!blob) { encoding = false; return }
          void blob.arrayBuffer().then(buffer => {
            encoding = false
            if (stopped || !connected.current || socketRef.current !== socket || socket.readyState !== WebSocket.OPEN || !profileRef.current) return
            if (buffer.byteLength > PHONE_CAMERA_FRAME_MAX) { setCamera('Camera image exceeds the relay frame limit'); return }
            const currentSequence = sequence.current = (sequence.current + 1) >>> 0
            socket.send(encodePhoneRelayMessage({ kind: 'camera-frame', profileId: opticalProfileNumber(profileRef.current), sequence: currentSequence, png: new Uint8Array(buffer) }))
            inFlight.current = { sequence: currentSequence, at: performance.now() }
            totals.current.sent += 1
          }).catch(() => { encoding = false })
        }, 'image/png')
      }
      if (typeof video.requestVideoFrameCallback === 'function') {
        const next = (now: number, metadata: VideoFrameCallbackMetadata) => { if (stopped) return; meter.current.add(now, metadata.presentedFrames); capture(now); videoCallback = video.requestVideoFrameCallback(next) }
        videoCallback = video.requestVideoFrameCallback(next)
      } else {
        const next = (now: number) => { if (stopped) return; meter.current.add(now, ++frameCounter); capture(now); animationCallback = requestAnimationFrame(next) }
        animationCallback = requestAnimationFrame(next)
      }
      const telemetry = window.setInterval(() => {
        const now = performance.now(), current = totals.current, seconds = (now - (current.lastAt || now - 1000)) / 1000
        const snapshot = { cameraFps: meter.current.fps, sentFps: (current.sent - current.previousSent) / seconds, validFps: (current.valid - current.previousValid) / seconds, uniqueFps: (current.unique - current.previousUnique) / seconds, sent: current.sent, valid: current.valid, failures: current.failures, lastReason: current.lastReason, resolution: `${video.videoWidth}×${video.videoHeight}` }
        setMetrics(snapshot)
        if (connected.current && socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(encodePhoneRelayMessage({ kind: 'telemetry', cameraFps: snapshot.cameraFps, processedFps: snapshot.sentFps, validFps: snapshot.validFps, uniqueFps: snapshot.uniqueFps, failures: current.failures, recoveredBlocks: 0, repeatedFrames: 0, usefulShards: 0, usefulShardBytes: 0, decodeReason: current.lastReason, finderStage: 0, pixelsPerCell: 0, capturePath: 4 }))
        current.previousSent = current.sent; current.previousValid = current.valid; current.previousUnique = current.unique; current.lastAt = now
      }, 1000)
      stopCameraRef.current = () => { stopped = true; clearInterval(telemetry); if (videoCallback !== null) video.cancelVideoFrameCallback(videoCallback); if (animationCallback !== null) cancelAnimationFrame(animationCallback); stopPeer(); cameraStreamRef.current = null; stream?.getTracks().forEach(item => item.stop()); video.pause(); video.srcObject = null; inFlight.current = null; stopCameraRef.current = null; setCamera('Camera stopped') }
    } catch (error) { stream?.getTracks().forEach(item => item.stop()); setCamera(error instanceof Error ? error.message : 'Camera unavailable') }
    finally { startingCamera.current = false }
  }
  useEffect(() => () => stopCameraRef.current?.(), [])
  if (!pairing) return <main style={{ padding: 24, fontFamily: 'system-ui' }}><h1>Incomplete phone pairing link</h1><p>Open the full QR pairing link from the desktop receiver, including its session token.</p><button onClick={() => { sessionStorage.removeItem('airgaplink-phone-pair'); location.href = location.pathname + location.search }}>Back to receiver</button></main>
  return <main style={{ maxWidth: 760, margin: 'auto', padding: 16, fontFamily: 'system-ui' }}>
    <h1>Airgaplink phone camera</h1>
    <p>{connection} · {profile ? `${profile.gridWidth}×${profile.gridHeight} ${profile.colorMode}` : 'waiting for optical profile'}</p>
    <p>{camera}</p><p>{cameraModes}</p><p>{opticsStatus}</p><p>{transport}</p>
    <button disabled={!profile || !!stopCameraRef.current} onClick={() => void startCamera()}>Start rear camera</button>{' '}
    <button disabled={!stopCameraRef.current} onClick={() => stopCameraRef.current?.()}>Stop camera</button>{' '}
    <button onClick={() => { stopCameraRef.current?.(); sessionStorage.removeItem('airgaplink-phone-pair'); location.href = location.pathname + location.search }}>Leave phone mode</button>
    <video ref={videoRef} muted playsInline style={{ display: 'block', width: '100%', marginTop: 12, background: '#111' }} />
    <p>Camera {metrics.cameraFps.toFixed(1)} FPS · {rtcActive.current ? 'WebRTC video streaming; desktop measures decode rate' : `fallback images ${metrics.sentFps.toFixed(1)}/s · desktop decoded ${metrics.validFps.toFixed(1)} valid/s · unique ${metrics.uniqueFps.toFixed(1)}/s`}</p>
    <p>Images sent {metrics.sent} · valid on desktop {metrics.valid} · rejected {metrics.failures} · last decode {PHONE_DECODE_REASONS[metrics.lastReason] || 'unknown'} · {metrics.resolution}</p>
    <p>The phone only captures camera images. The desktop detects the grid, validates CRC/FEC, authenticates AES-GCM, and stores recovered blocks.</p>
  </main>
}
