import { randomBytes } from 'crypto'
import express, { Request, Response } from 'express'
import cors from 'cors'

const app: express.Express = express()
const PORT = Number(process.env.SENDER_API_PORT || 3001)
const EVENT_COOKIE = 'qrcopy_events'
const EVENT_SESSION_TTL_MS = 60 * 60 * 1000

app.use(cors())
app.use(express.json({ limit: '64kb' }))

interface Transfer {
  id: string
  receiverSessionId: string
  receivedRanges: ChunkRange[]
  createdAt: Date
}

interface ChunkRange { start: number; end: number }

const transfers = new Map<string, Transfer>()
const eventSessions = new Map<string, { transferId: string; expiresAt: number }>()
const eventSubscribers = new Map<string, Set<Response>>()
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

function randomCode() {
  return Array.from(randomBytes(8), (byte) => CODE_ALPHABET[byte & 31]).join('')
}

function isCode(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z2-9]{8}$/.test(value)
}

function randomOpaqueToken() {
  return randomBytes(32).toString('base64url')
}

function readCookie(req: Request, name: string) {
  const cookieHeader = req.headers.cookie
  if (!cookieHeader) return undefined
  for (const pair of cookieHeader.split(';')) {
    const separator = pair.indexOf('=')
    if (separator < 1 || pair.slice(0, separator).trim() !== name) continue
    try {
      return decodeURIComponent(pair.slice(separator + 1).trim())
    } catch {
      return undefined
    }
  }
  return undefined
}

function removeExpiredEventSessions() {
  const now = Date.now()
  for (const [token, session] of eventSessions) {
    if (session.expiresAt <= now) eventSessions.delete(token)
  }
}

function responseFor(transfer: Transfer) {
  return {
    transferId: transfer.id,
    receiverSessionId: transfer.receiverSessionId,
    receivedRanges: transfer.receivedRanges,
  }
}

function normalizeRanges(value: unknown): ChunkRange[] | null {
  if (!Array.isArray(value)) return null
  const ranges: ChunkRange[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') return null
    const { start, end } = item as Record<string, unknown>
    if (typeof start !== 'number' || typeof end !== 'number' || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > 0xffffffff) return null
    ranges.push({ start, end })
  }
  ranges.sort((left, right) => left.start - right.start)
  const normalized: ChunkRange[] = []
  for (const range of ranges) {
    const previous = normalized[normalized.length - 1]
    if (previous && range.start <= previous.end + 1) previous.end = Math.max(previous.end, range.end)
    else normalized.push({ ...range })
  }
  return normalized
}

function writeTransferEvent(response: Response, transfer: Transfer) {
  response.write(`event: transfer\ndata: ${JSON.stringify(responseFor(transfer))}\n\n`)
}

function publishTransfer(transfer: Transfer) {
  const subscribers = eventSubscribers.get(transfer.id)
  if (!subscribers) return
  for (const response of subscribers) {
    if (response.destroyed || response.writableEnded) subscribers.delete(response)
    else writeTransferEvent(response, transfer)
  }
  if (subscribers.size === 0) eventSubscribers.delete(transfer.id)
}

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'sender-api' })
})

/**
 * Transfer status stream. The URL intentionally contains no transfer ID or
 * token: an opaque, short-lived HttpOnly cookie created with the transfer
 * authorizes this EventSource connection.
 */
app.get('/api/events', (req, res) => {
  removeExpiredEventSessions()
  const token = readCookie(req, EVENT_COOKIE)
  const eventSession = token ? eventSessions.get(token) : undefined
  const transfer = eventSession && transfers.get(eventSession.transferId)
  if (!transfer) return res.status(401).end()

  res.status(200).set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.flushHeaders()
  writeTransferEvent(res, transfer)

  let subscribers = eventSubscribers.get(transfer.id)
  if (!subscribers) {
    subscribers = new Set()
    eventSubscribers.set(transfer.id, subscribers)
  }
  subscribers.add(res)

  const heartbeat = setInterval(() => {
    if (!res.destroyed && !res.writableEnded) res.write(': keep-alive\n\n')
  }, 20_000)
  req.on('close', () => {
    clearInterval(heartbeat)
    subscribers?.delete(res)
    if (subscribers?.size === 0) eventSubscribers.delete(transfer.id)
  })
})

/**
 * Register transfer metadata only. ZIP bytes stay in the sender browser and
 * travel exclusively through QR codes.
 */
app.post('/api/transfers', (req, res) => {
  const { receiverSessionId } = req.body as {
    receiverSessionId?: string
  }
  const sessionCode = receiverSessionId?.trim()
  if (!isCode(sessionCode)) {
    return res.status(400).json({ error: 'An 8-character receiver session code is required' })
  }
  let transferId = randomCode()
  while (transfers.has(transferId)) transferId = randomCode()
  const transfer: Transfer = {
    id: transferId,
    receiverSessionId: sessionCode,
    receivedRanges: [],
    createdAt: new Date(),
  }
  transfers.set(transfer.id, transfer)
  removeExpiredEventSessions()
  let eventToken = randomOpaqueToken()
  while (eventSessions.has(eventToken)) eventToken = randomOpaqueToken()
  eventSessions.set(eventToken, { transferId: transfer.id, expiresAt: Date.now() + EVENT_SESSION_TTL_MS })
  res.cookie(EVENT_COOKIE, eventToken, {
    httpOnly: true,
    sameSite: 'strict',
    secure: req.secure || req.get('x-forwarded-proto') === 'https',
    maxAge: EVENT_SESSION_TTL_MS,
    path: '/api/events',
  })
  res.status(201).json(responseFor(transfer))
})

app.get('/api/transfers/:transferId', (req, res) => {
  const transfer = transfers.get(req.params.transferId)
  if (!transfer) return res.status(404).json({ error: 'Transfer not found' })
  res.json(responseFor(transfer))
})

/**
 * The receiver reports compact received ranges periodically. This metadata is
 * independent of individual camera frames and contains no ZIP bytes.
 */
app.post('/api/transfers/:transferId/control', (req, res) => {
  const transfer = transfers.get(req.params.transferId)
  if (!transfer) return res.status(404).json({ error: 'Transfer not found' })
  const { receiverSessionId, receivedRanges } = req.body as {
    receiverSessionId?: string
    receivedRanges?: unknown
  }
  const normalized = normalizeRanges(receivedRanges)
  if (receiverSessionId !== transfer.receiverSessionId || !normalized) {
    return res.status(400).json({ error: 'Invalid control update' })
  }
  transfer.receivedRanges = normalized
  publishTransfer(transfer)
  res.json(responseFor(transfer))
})

app.listen(PORT, () => {
  console.log(`Sender API running on port ${PORT}`)
})

export default app
