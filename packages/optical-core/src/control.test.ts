import { ControlType, decodeFskSamples, encodeCompactFskPacket, encodeFskPacket, makeBlockStatusPayload, makeCompactStatusPayload, readBlockStatusPayload, readCompactStatusPayload } from './control.ts'

const payload = makeBlockStatusPayload(96, 0xf0a20cc3)
const packet = { type: ControlType.BLOCK_STATUS, transferId: 0x9127ea45, sequence: 44, payload }
const encoded = encodeFskPacket(packet, 48000)
const samples = new Float32Array(encoded.length + 2117)
for (let index = 0; index < samples.length; index += 1) samples[index] = (((index * 17) % 31) - 15) * 0.0006
samples.set(encoded, 2117)
const decoded = decodeFskSamples(samples, 48000)
if (decoded.length !== 1 || decoded[0].transferId !== packet.transferId || decoded[0].sequence !== packet.sequence) throw new Error('Acoustic packet failed synthetic round trip')
const status = readBlockStatusPayload(decoded[0].payload)
if (!status || status.baseBlock !== 96 || status.bitmap !== 0xf0a20cc3) throw new Error('Acoustic block bitmap changed')
const sessionId = 0x6135d902
const hello = decodeFskSamples(encodeFskPacket({ type: ControlType.HELLO, transferId: sessionId, sequence: 1, payload: new Uint8Array() }, 48000), 48000)
if (hello.length !== 1 || hello[0].type !== ControlType.HELLO || hello[0].transferId !== sessionId || hello[0].payload.length) throw new Error('Acoustic session HELLO failed')
const storageHello = decodeFskSamples(encodeFskPacket({ type: ControlType.HELLO, transferId: sessionId, sequence: 3, payload: Uint8Array.of(0) }, 48000), 48000)
if (storageHello.length !== 1 || storageHello[0].payload.length !== 1 || storageHello[0].payload[0] !== 0) throw new Error('Receiver storage capability changed during acoustic HELLO')
const ready = decodeFskSamples(encodeFskPacket({ type: ControlType.READY, transferId: sessionId, sequence: 2, payload }, 48000), 48000)
const readyStatus = ready.length === 1 ? readBlockStatusPayload(ready[0].payload) : null
if (ready.length !== 1 || ready[0].type !== ControlType.READY || ready[0].transferId !== sessionId || readyStatus?.bitmap !== 0xf0a20cc3) throw new Error('Acoustic READY and first ACK failed')
const compactPayload = makeCompactStatusPayload(12345, 0b1010, 4)
const compactPacket = { type: ControlType.BLOCK_STATUS, transferId: sessionId, sequence: 9, payload: compactPayload }
const compactSound = encodeCompactFskPacket(compactPacket, 48000)
const compactDecoded = decodeFskSamples(compactSound, 48000)
const compactStatus = compactDecoded.length === 1 ? readCompactStatusPayload(compactDecoded[0].payload) : null
if (compactDecoded.length !== 1 || compactDecoded[0].transferId !== sessionId || compactDecoded[0].sequence !== 9 || compactStatus?.firstMissing !== 12345 || compactStatus.bitmap !== 0b1010 || compactStatus.paceCode !== 4) throw new Error('Compact cumulative block ACK and pace report failed')
const selected = decodeFskSamples(encodeCompactFskPacket({ type: ControlType.CALIBRATION_SELECTED, transferId: sessionId, sequence: 10, payload: Uint8Array.of(1, 1, 4, 0) }, 48000), 48000)
if (selected.length !== 1 || selected[0].type !== ControlType.CALIBRATION_SELECTED || selected[0].payload[2] !== 4) throw new Error('Acoustic calibration selection failed')
if (compactSound.length >= encoded.length * 0.65) throw new Error('Compact ACK did not materially shorten the audio packet')
const mixedHello = encodeFskPacket({ type: ControlType.HELLO, transferId: sessionId, sequence: 8, payload: new Uint8Array() }, 48000)
const mixed = new Float32Array(mixedHello.length + 1000 + compactSound.length)
mixed.set(mixedHello); mixed.set(compactSound, mixedHello.length + 1000)
const mixedDecoded = decodeFskSamples(mixed, 48000)
if (mixedDecoded.length !== 2 || mixedDecoded[0].type !== ControlType.HELLO || mixedDecoded[1].type !== ControlType.BLOCK_STATUS) throw new Error('Mixed handshake and compact ACK were not decoded in sound order')
const compactCorrupted = compactSound.slice()
compactCorrupted.fill(0, Math.floor(compactCorrupted.length / 3), Math.floor(compactCorrupted.length * 2 / 3))
if (decodeFskSamples(compactCorrupted, 48000).length) throw new Error('Corrupted compact ACK passed CRC')
const linkPayload = Uint8Array.of(2, 1) // optical profile 2, protocol version 1
for (const [index, type] of [ControlType.PROFILE_SELECTED, ControlType.PAUSE, ControlType.RESUME].entries()) {
  const link = decodeFskSamples(encodeFskPacket({ type, transferId: sessionId, sequence: 5 + index, payload: linkPayload }, 48000), 48000)
  if (link.length !== 1 || link[0].type !== type || link[0].transferId !== sessionId || link[0].payload[0] !== 2 || link[0].payload[1] !== 1) throw new Error('Acoustic optical-link control failed')
}
const corrupted = samples.slice()
corrupted.fill(0, Math.floor(corrupted.length / 2), Math.floor(corrupted.length / 2) + 48000)
if (decodeFskSamples(corrupted, 48000).length) throw new Error('Corrupted acoustic control passed CRC')
console.log(JSON.stringify({ result: 'ok', bitsPerSecond: Math.round(1 / 0.016), packetSeconds: Number((encoded.length / 48000).toFixed(2)), compactAckSeconds: Number((compactSound.length / 48000).toFixed(2)) }))
