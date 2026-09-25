import { RotatingShardOrder } from './shard-order.ts'

const order = new RotatingShardOrder(10)
const sampled = new Set<number>()
for (let frame = 0; frame < 40; frame += 1) {
  const symbol = order.index(0, frame)
  // Simulate a camera locked to just six of ten display positions.
  if (frame % 10 < 6) sampled.add(symbol)
}
if (sampled.size !== 10) throw new Error(`Phase-locked camera only saw ${sampled.size} distinct shards`)

const windowOrder = new RotatingShardOrder(10)
const perBlock = Array.from({ length: 4 }, () => new Set<number>())
let frame = 0
for (let cycle = 0; cycle < 10; cycle += 1) {
  for (let block = 0; block < 4; block += 1) {
    for (let position = 0; position < 10; position += 1, frame += 1) {
      const symbol = windowOrder.index(block + 1, frame)
      if (position < 6) perBlock[block].add(symbol)
    }
  }
}
if (perBlock.some(symbols => symbols.size !== 10)) throw new Error('Rotating window failed to expose every shard')
console.log(JSON.stringify({ result: 'ok', phaseLockedShards: sampled.size, windowShards: perBlock.map(item => item.size) }))
