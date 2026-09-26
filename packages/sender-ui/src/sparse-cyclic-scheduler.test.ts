import assert from 'node:assert/strict'
import { ReceivedBlockMap } from '../../optical-core/src/received-block-map.ts'
import { SparseCyclicScheduler } from './sparse-cyclic-scheduler.ts'

function visit(scheduler: SparseCyclicScheduler, total: number, now = 0) {
  const selected = scheduler.select(total, now)
  assert.equal(scheduler.select(total, now + 1), selected, 'selection must remain stable during async loading')
  for (let frame = 0; frame < 10; frame += 1) scheduler.frameEmitted()
  return selected
}

const noHints = new SparseCyclicScheduler(10)
assert.deepEqual(Array.from({ length: 21 }, () => visit(noHints, 7).blockId), [0, 1, 2, 3, 4, 5, 6, 0, 1, 2, 3, 4, 5, 6, 0, 1, 2, 3, 4, 5, 6])
assert.equal(noHints.metrics.cycleCount, 3)
assert.equal(noHints.metrics.emittedFrames, 210)
const receiver = new ReceivedBlockMap(); receiver.configure(7)
const lossy = new SparseCyclicScheduler(10)
for (let cycle = 0; cycle < 3; cycle += 1) {
  for (let index = 0; index < 7; index += 1) {
    const block = visit(lossy, 7).blockId
    if (cycle === 0 && (block === 1 || block === 4)) continue // lost entirely on the first cycle
    receiver.add(block) // later cycles may duplicate an already durable block
  }
  if (cycle === 0) { assert.equal(receiver.size, 5); assert.equal(receiver.firstMissing(), 1) }
}
assert.equal(receiver.size, 7, 'cyclic repetition repairs dropped blocks without any acoustic hint')
assert.equal(receiver.missingCount, 0)
const rotations = new SparseCyclicScheduler(10)
for (let round = 0; round < 4; round += 1) {
  const selected = rotations.select(1, 0)
  assert.equal(selected.visit, round)
  const indices = Array.from({ length: 10 }, (_, position) => (position + selected.visit * 3) % 10)
  assert.equal(new Set(indices).size, 10, 'each visit must emit every distinct FEC shard')
  for (let frame = 0; frame < 10; frame += 1) rotations.frameEmitted()
}
const paused = new SparseCyclicScheduler(10)
const partial = paused.select(2, 0)
for (let frame = 0; frame < 5; frame += 1) paused.frameEmitted()
paused.restartVisit()
assert.equal(paused.select(2, 1), partial)
for (let frame = 0; frame < 10; frame += 1) paused.frameEmitted()
assert.equal(paused.select(2, 2).blockId, 1, 'a resumed visit must emit a complete shard set')

const hinted = new SparseCyclicScheduler(10)
assert.equal(hinted.addHint({ windowBase: 32, missingMask: 1 << 3, completedCount: 95 }, 100, 100), true)
const selected = Array.from({ length: 100 }, (_, index) => visit(hinted, 100, 100 + index))
assert.deepEqual(selected.filter(item => !item.hinted).slice(0, 50).map(item => item.blockId), Array.from({ length: 50 }, (_, index) => index))
assert.ok(selected.some(item => item.hinted && item.blockId === 35))
assert.ok(hinted.metrics.hintedRetransmissions > 0)
assert.equal(hinted.addHint({ windowBase: -32, missingMask: 1, completedCount: 99 }, 100, 100), false)
assert.equal(hinted.addHint({ windowBase: 0, missingMask: 0, completedCount: 99 }, 100, 100), false)
assert.equal(hinted.addHint({ windowBase: 999, missingMask: 1, completedCount: 99 }, 100, 100), false)
assert.equal(hinted.addHint({ windowBase: 96, missingMask: 1 << 7, completedCount: 99 }, 100, 100), false)
assert.equal(hinted.addHint({ windowBase: 32, missingMask: 1 << 3, completedCount: 94 }, 100, 200), true, 'stale hints are harmless')
assert.equal(hinted.metrics.completedEstimate, 95)
for (let step = 0; step < 220; step += 1) visit(hinted, 100, 31_000 + step)
assert.ok(hinted.metrics.cycleCount >= 2, 'hints cannot starve the cyclic scan')
assert.equal(hinted.metrics.pendingHints, 0, 'old hints expire')
console.log(JSON.stringify({ result: 'ok', cycles: hinted.metrics.cycleCount, hintedVisits: hinted.metrics.hintedRetransmissions }))
