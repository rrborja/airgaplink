import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import express from 'express'
import { WebSocket } from 'ws'
import { attachOpticalRelay } from './optical-relay'

async function main() {
const app = express(), server = createServer(app)
const relay = attachOpticalRelay(app, server)
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const address = server.address()
if (!address || typeof address === 'string') throw new Error('Test relay did not start')
const base = `http://127.0.0.1:${address.port}`
const response = await fetch(`${base}/api/optical-relay/session`, { method: 'POST' })
assert.equal(response.status, 201)
assert.equal(response.headers.get('cache-control'), 'no-store')
const pair = await response.json() as { id: string; token: string }
assert.match(pair.id, /^[A-Za-z0-9_-]{12}$/)
assert.match(pair.token, /^[A-Za-z0-9_-]{32}$/)
const open = async () => { const socket = new WebSocket(base.replace('http:', 'ws:') + '/optical-relay'); await once(socket, 'open'); return socket }
const waitFor = (socket: WebSocket, predicate: (data: Buffer, binary: boolean) => boolean) => new Promise<Buffer>((resolve, reject) => {
  const timer = setTimeout(() => { socket.off('message', receive); reject(new Error('Timed out waiting for relay message')) }, 1000)
  function receive(data: Buffer, binary: boolean) { if (predicate(data, binary)) { clearTimeout(timer); socket.off('message', receive); resolve(data) } }
  socket.on('message', receive)
})
const desktop = await open(), phone = await open()
const desktopAuth = waitFor(desktop, data => data.toString().includes('authenticated'))
desktop.send(JSON.stringify({ type: 'auth', role: 'desktop', ...pair }))
await desktopAuth
const phoneAuth = waitFor(phone, data => data.toString().includes('authenticated'))
phone.send(JSON.stringify({ type: 'auth', role: 'phone', ...pair }))
await phoneAuth
const block = Buffer.from([0x50, 0x4f, 1, 3, 7, 8, 9])
const delivered = waitFor(desktop, (_data, binary) => binary)
phone.send(block)
assert.deepEqual(await delivered, block)
const cameraFrame = Buffer.alloc(120_013); cameraFrame.set([0x50, 0x4f, 1, 7, 8])
const deliveredFrame = waitFor(desktop, (data, binary) => binary && data.length === cameraFrame.length)
phone.send(cameraFrame)
assert.deepEqual(await deliveredFrame, cameraFrame)
const reply = waitFor(phone, (_data, binary) => binary)
desktop.send(Buffer.from([0x50, 0x4f, 1, 6]))
assert.deepEqual(await reply, Buffer.from([0x50, 0x4f, 1, 6]))
const offer = JSON.stringify({ type: 'webrtc-signal', kind: 'offer', sdp: 'v=0\r\n' })
const forwardedOffer = waitFor(desktop, (data, binary) => !binary && data.toString() === offer)
phone.send(offer)
assert.equal((await forwardedOffer).toString(), offer)
const answer = JSON.stringify({ type: 'webrtc-signal', kind: 'answer', sdp: 'v=0\r\n' })
const forwardedAnswer = waitFor(phone, (data, binary) => !binary && data.toString() === answer)
desktop.send(answer)
assert.equal((await forwardedAnswer).toString(), answer)
const candidate = JSON.stringify({ type: 'webrtc-signal', kind: 'candidate', candidate: { candidate: 'candidate:1 1 udp 1 192.168.1.2 1234 typ host', sdpMid: '0' } })
const forwardedCandidate = waitFor(desktop, (data, binary) => !binary && data.toString() === candidate)
phone.send(candidate)
assert.equal((await forwardedCandidate).toString(), candidate)
const intruder = await open()
const rejected = once(intruder, 'close')
intruder.send(JSON.stringify({ type: 'auth', role: 'phone', id: pair.id, token: 'A'.repeat(32) }))
assert.equal((await rejected)[0], 1008)
const reconnect = await open()
const reauthenticated = waitFor(reconnect, data => data.toString().includes('authenticated'))
reconnect.send(JSON.stringify({ type: 'auth', role: 'phone', ...pair }))
await reauthenticated
const afterReconnect = waitFor(desktop, (_data, binary) => binary)
reconnect.send(block)
assert.deepEqual(await afterReconnect, block)
desktop.close(); phone.close(); reconnect.close(); relay.close(); server.close()
console.log(JSON.stringify({ result: 'ok', authenticatedRelay: true, reconnect: true }))
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
