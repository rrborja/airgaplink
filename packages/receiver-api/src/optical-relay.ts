import { randomBytes, timingSafeEqual } from 'crypto'
import type { Server } from 'http'
import type express from 'express'
import { WebSocket, WebSocketServer, type RawData } from 'ws'

type Role = 'desktop' | 'phone'
interface Session { id: string; token: Buffer; expiresAt: number; desktop?: WebSocket; phone?: WebSocket }
const INITIAL_TTL_MS = 5 * 60_000
const ACTIVE_TTL_MS = 12 * 60 * 60_000
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024 + 13
const sessions = new Map<string, Session>()

function randomToken(bytes: number) { return randomBytes(bytes).toString('base64url') }
function sendStatus(session: Session) {
  for (const role of ['desktop', 'phone'] as const) {
    const peer = session[role]
    if (peer?.readyState === WebSocket.OPEN) peer.send(JSON.stringify({ type: 'peer', connected: session[role === 'desktop' ? 'phone' : 'desktop']?.readyState === WebSocket.OPEN }))
  }
}

/** A bounded, opaque LAN relay. It never decrypts optical blocks or receives
 * X25519 private keys, derived AES keys, filenames, or archive plaintext. */
export function attachOpticalRelay(app: express.Express, server: Server) {
  app.post('/api/optical-relay/session', (_request, response) => {
    for (const [id, session] of sessions) if (session.expiresAt < Date.now()) sessions.delete(id)
    if (sessions.size >= 256) return response.status(503).json({ error: 'Too many active phone pairings' })
    const id = randomToken(9), token = randomBytes(24)
    sessions.set(id, { id, token, expiresAt: Date.now() + INITIAL_TTL_MS })
    response.set('Cache-Control', 'no-store').status(201).json({ id, token: token.toString('base64url'), expiresInSeconds: INITIAL_TTL_MS / 1000 })
  })
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES })
  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/optical-relay') { socket.destroy(); return }
    sockets.handleUpgrade(request, socket, head, peer => sockets.emit('connection', peer, request))
  })
  sockets.on('connection', socket => {
    let session: Session | undefined, role: Role | undefined
    const authTimer = setTimeout(() => socket.close(1008, 'Pairing authentication required'), 5000)
    socket.on('message', (raw: RawData, binary: boolean) => {
      const data = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw)
      if (!session) {
        if (binary || data.length > 512) { socket.close(1008, 'Invalid pairing message'); return }
        let auth: { type?: unknown; id?: unknown; token?: unknown; role?: unknown }
        try { auth = JSON.parse(data.toString()) } catch { socket.close(1008, 'Invalid pairing message'); return }
        const candidate = typeof auth.id === 'string' ? sessions.get(auth.id) : undefined
        const supplied = typeof auth.token === 'string' && /^[A-Za-z0-9_-]{32}$/.test(auth.token) ? Buffer.from(auth.token, 'base64url') : Buffer.alloc(0)
        if (auth.type !== 'auth' || (auth.role !== 'desktop' && auth.role !== 'phone') || !candidate || candidate.expiresAt < Date.now() || supplied.length !== candidate.token.length || !timingSafeEqual(supplied, candidate.token)) { socket.close(1008, 'Invalid or expired pairing'); return }
        session = candidate; role = auth.role
        clearTimeout(authTimer)
        const old = session[role]
        session[role] = socket
        if (old && old !== socket) old.close(1000, 'Reconnected')
        // The QR remains short-lived until a phone actually joins. Desktop
        // authentication alone must not extend an unscanned QR for 12 hours.
        if (session.desktop && session.phone) session.expiresAt = Date.now() + ACTIVE_TTL_MS
        socket.send(JSON.stringify({ type: 'authenticated', role }))
        sendStatus(session)
        return
      }
      if (!role) { socket.close(1008, 'Pairing authentication required'); return }
      const destination = session[role === 'desktop' ? 'phone' : 'desktop']
      if (!binary) {
        // SDP/ICE is control-plane signaling only. Camera video flows directly
        // between the paired browsers over WebRTC, not through this relay.
        if (data.length > 64 * 1024) { socket.close(1009, 'WebRTC signal too large'); return }
        let signal: { type?: unknown; kind?: unknown; sdp?: unknown; candidate?: unknown }
        try { signal = JSON.parse(data.toString()) } catch { socket.close(1008, 'Invalid WebRTC signal'); return }
        if (signal.type !== 'webrtc-signal' || !['offer', 'answer', 'candidate'].includes(String(signal.kind)) || (signal.kind === 'candidate' ? typeof signal.candidate !== 'object' || signal.candidate === null : typeof signal.sdp !== 'string' || signal.sdp.length > 60_000)) { socket.close(1008, 'Invalid WebRTC signal'); return }
        if (destination?.readyState === WebSocket.OPEN && destination.bufferedAmount < 64 * 1024) destination.send(data.toString())
        return
      }
      if (destination?.readyState === WebSocket.OPEN && destination.bufferedAmount < 2 * MAX_MESSAGE_BYTES) destination.send(data, { binary: true })
    })
    socket.on('close', () => {
      clearTimeout(authTimer)
      if (session && role && session[role] === socket) { delete session[role]; sendStatus(session) }
    })
  })
  const cleanup = setInterval(() => {
    for (const [id, session] of sessions) if (session.expiresAt < Date.now()) {
      session.desktop?.close(1008, 'Pairing expired'); session.phone?.close(1008, 'Pairing expired'); sessions.delete(id)
    }
  }, 60_000)
  cleanup.unref()
  return sockets
}
