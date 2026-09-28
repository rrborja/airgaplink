import { randomBytes } from 'crypto'
import express from 'express'
import cors from 'cors'
import { attachOpticalRelay } from './optical-relay'

const app: express.Express = express()
const PORT = Number(process.env.RECEIVER_API_PORT || 3002)
const SENDER_API_URL = process.env.SENDER_API_URL || 'http://localhost:3001'
const MAGIC = 'QRC2'
const HEADER_BYTES = 38
const FEC_GROUP_SIZE = 8
const CONTROL_INTERVAL_MS = 500
app.use(cors())
app.use(express.raw({ type: 'application/octet-stream', limit: '2mb' }))
app.use(express.json({ limit: '64kb' }))

type FrameKind = 'data' | 'parity'
interface Frame { kind: FrameKind; sessionId: string; transferId: string; totalChunks: number; index: number; totalBytes: number; chunkBytes: number; payload: Buffer }
interface ChunkRange { start: number; end: number }
interface ReceivedTransfer { id: string; totalChunks: number; totalBytes: number; chunkBytes: number; chunks: Map<number, Buffer>; parity: Map<number, Buffer>; reportTimer?: NodeJS.Timeout; completedArchive?: Buffer }
interface Session { id: string; status: 'waiting' | 'receiving' | 'complete'; startedAt: Date; transfer?: ReceivedTransfer }
const sessions = new Map<string, Session>()
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const randomCode = () => Array.from(randomBytes(8), byte => CODE_ALPHABET[byte & 31]).join('')
const isCode = (value: string) => /^[A-Z2-9]{8}$/.test(value)

function parseFrame(value: unknown): Frame | null {
  if (!Buffer.isBuffer(value) || value.length < HEADER_BYTES || value.subarray(0, 4).toString('ascii') !== MAGIC || value[4] !== 1) return null
  const kind = value[5] === 0 ? 'data' : value[5] === 1 ? 'parity' : null
  const sessionId = value.subarray(6, 14).toString('ascii'), transferId = value.subarray(14, 22).toString('ascii')
  const totalChunks = value.readUInt32BE(22), index = value.readUInt32BE(26), totalBytes = value.readUInt32BE(30), chunkBytes = value.readUInt16BE(34), payloadLength = value.readUInt16BE(36)
  if (!kind || !isCode(sessionId) || !isCode(transferId) || totalChunks < 1 || totalBytes < 1 || chunkBytes < 1 || payloadLength > chunkBytes || value.length !== HEADER_BYTES + payloadLength) return null
  if ((kind === 'data' && index >= totalChunks) || (kind === 'parity' && index >= Math.ceil(totalChunks / FEC_GROUP_SIZE))) return null
  return { kind, sessionId, transferId, totalChunks, index, totalBytes, chunkBytes, payload: value.subarray(HEADER_BYTES) }
}
const expectedLength = (transfer: ReceivedTransfer, index: number) => Math.min(transfer.chunkBytes, transfer.totalBytes - index * transfer.chunkBytes)
function xorInto(target: Buffer, source: Buffer) { for (let index = 0; index < target.length; index += 1) target[index] ^= source[index] || 0 }
function recoverGroup(transfer: ReceivedTransfer, groupIndex: number) {
  const parity = transfer.parity.get(groupIndex); if (!parity) return
  const first = groupIndex * FEC_GROUP_SIZE, count = Math.min(FEC_GROUP_SIZE, transfer.totalChunks - first)
  const indexes = Array.from({ length: count }, (_, offset) => first + offset), missing = indexes.filter(index => !transfer.chunks.has(index))
  if (missing.length !== 1) return
  const recovered = Buffer.from(parity)
  for (const index of indexes) if (index !== missing[0]) xorInto(recovered, transfer.chunks.get(index)!)
  transfer.chunks.set(missing[0], recovered.subarray(0, expectedLength(transfer, missing[0])))
}
function receivedRanges(transfer: ReceivedTransfer): ChunkRange[] {
  const ranges: ChunkRange[] = []
  const groupCount = Math.ceil(transfer.totalChunks / FEC_GROUP_SIZE)
  for (let index = 0; index < groupCount; index += 1) {
    const first = index * FEC_GROUP_SIZE, count = Math.min(FEC_GROUP_SIZE, transfer.totalChunks - first)
    if (Array.from({ length: count }, (_, offset) => transfer.chunks.has(first + offset)).some(present => !present)) continue
    const previous = ranges[ranges.length - 1]
    if (previous && index === previous.end + 1) previous.end = index
    else ranges.push({ start: index, end: index })
  }
  return ranges
}
async function reportControl(session: Session, transfer: ReceivedTransfer) {
  transfer.reportTimer = undefined
  try { await fetch(`${SENDER_API_URL}/api/transfers/${transfer.id}/control`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ receiverSessionId: session.id, receivedRanges: receivedRanges(transfer) }) }) } catch { /* next batch retries */ }
}
function scheduleControl(session: Session, transfer: ReceivedTransfer) { if (!transfer.reportTimer) transfer.reportTimer = setTimeout(() => void reportControl(session, transfer), CONTROL_INTERVAL_MS) }

app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'receiver-api' }))
app.post('/api/start-session', (_req, res) => { let id = randomCode(); while (sessions.has(id)) id = randomCode(); sessions.set(id, { id, status: 'waiting', startedAt: new Date() }); res.status(201).json({ sessionId: id }) })
app.get('/api/session/:sessionId', (req, res) => { const session = sessions.get(req.params.sessionId); if (!session) return res.status(404).json({ error: 'Session not found' }); const transfer = session.transfer; res.json({ sessionId: session.id, status: session.status, transferId: transfer?.id, receivedChunks: transfer?.chunks.size ?? 0, totalChunks: transfer?.totalChunks ?? 0, complete: Boolean(transfer?.completedArchive) }) })
app.post('/api/receive', (req, res) => {
  const frame = parseFrame(req.body); if (!frame) return res.status(400).json({ error: 'Invalid binary QR frame' })
  const session = sessions.get(frame.sessionId); if (!session) return res.status(404).json({ error: 'Receiver session not found' })
  let transfer = session.transfer
  if (!transfer) { transfer = { id: frame.transferId, totalChunks: frame.totalChunks, totalBytes: frame.totalBytes, chunkBytes: frame.chunkBytes, chunks: new Map(), parity: new Map() }; session.transfer = transfer }
  if (transfer.id !== frame.transferId || transfer.totalChunks !== frame.totalChunks || transfer.totalBytes !== frame.totalBytes || transfer.chunkBytes !== frame.chunkBytes) return res.status(409).json({ error: 'Frame belongs to a different transfer' })
  if (frame.kind === 'data' && frame.payload.length === expectedLength(transfer, frame.index) && !transfer.chunks.has(frame.index)) transfer.chunks.set(frame.index, frame.payload)
  if (frame.kind === 'parity' && frame.payload.length === transfer.chunkBytes) transfer.parity.set(frame.index, frame.payload)
  recoverGroup(transfer, Math.floor(frame.index / (frame.kind === 'data' ? FEC_GROUP_SIZE : 1)))
  session.status = 'receiving'
  if (transfer.chunks.size === transfer.totalChunks && !transfer.completedArchive) { transfer.completedArchive = Buffer.concat(Array.from({ length: transfer.totalChunks }, (_, index) => transfer!.chunks.get(index)!)); session.status = 'complete' }
  scheduleControl(session, transfer)
  res.json({ receivedChunks: transfer.chunks.size, totalChunks: transfer.totalChunks, complete: session.status === 'complete' })
})
app.get('/api/session/:sessionId/archive', (req, res) => { const archive = sessions.get(req.params.sessionId)?.transfer?.completedArchive; if (!archive) return res.status(409).json({ error: 'Archive is not complete' }); res.type('application/zip').attachment(`qr-transfer-${req.params.sessionId}.zip`).send(archive) })
const server = app.listen(PORT, () => console.log(`Receiver API running on port ${PORT}`))
attachOpticalRelay(app, server)
export default app
