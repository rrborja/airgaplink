import { AudioBlockScheduler } from './audio-block-scheduler.ts'

const scheduler = new AudioBlockScheduler(10)
const acknowledged = new Set<number>(), capturedManifestSymbols = new Set<number>()
const loadingScheduler = new AudioBlockScheduler(10)
const manifestAcknowledged = new Set([0])
if (loadingScheduler.next(10, 5000, manifestAcknowledged) !== 1) throw new Error('First file block was not selected')
for (let retry = 0; retry < 30; retry += 1) {
  if (loadingScheduler.next(10, 5000, manifestAcknowledged) !== 1) throw new Error('Block selection changed while the same optical frame was awaiting a disk read')
}
if (loadingScheduler.next(20, 5000, manifestAcknowledged) !== 2) throw new Error('Block did not advance on the next rendered frame boundary')
for (let retry = 0; retry < 30; retry += 1) {
  if (loadingScheduler.next(20, 5000, manifestAcknowledged) !== 2) throw new Error('New block selection changed while loading')
}
let manifestReadyAt = -1
for (let frame = 0; frame < 200; frame += 1) {
  const block = scheduler.next(frame, 5000, acknowledged)
  if (block !== 0) throw new Error('Manifest block was abandoned before acknowledgement')
  // A camera that accepts only one in seven optical frames must still be able
  // to collect eight distinct source or repair shards before the next block.
  if (frame % 7 === 0) capturedManifestSymbols.add(frame % 10)
  if (capturedManifestSymbols.size >= 8) { manifestReadyAt = frame; break }
}
if (manifestReadyAt < 0) throw new Error('Manifest did not complete after repeated optical frames')

acknowledged.add(0)
const windowBlocks = new Set<number>()
for (let frame = manifestReadyAt + 1; frame < manifestReadyAt + 201; frame += 1) {
  const block = scheduler.next(frame, 5000, acknowledged)
  if (block < 1 || block > 4) throw new Error(`Optical scheduler escaped its repair window: ${block}`)
  windowBlocks.add(block)
}
if (windowBlocks.size !== 4) throw new Error('Incomplete blocks were not revisited')
acknowledged.add(1)
// A PAUSE/RESUME recreates the display scheduler. Stored-block ACKs must keep
// it in the same batch rather than skipping the missing camera symbols.
const resumedScheduler = new AudioBlockScheduler(10)
for (let frame = manifestReadyAt + 201; frame < manifestReadyAt + 251; frame += 1) {
  const block = resumedScheduler.next(frame, 5000, acknowledged)
  if (block < 2 || block > 4) throw new Error('Next batch started before all four blocks were acknowledged')
}
for (let block = 2; block <= 4; block += 1) acknowledged.add(block)
if (resumedScheduler.next(manifestReadyAt + 201, 5000, acknowledged) !== 5) throw new Error('Window did not advance after block ACKs')
console.log(JSON.stringify({ result: 'ok', manifestReadyAt, windowBlocks: [...windowBlocks] }))
