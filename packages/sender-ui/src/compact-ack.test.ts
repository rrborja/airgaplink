import { applyCompactBlockStatus } from './compact-ack.ts'

const acknowledged = new Set<number>()
let floor = 0
// The first status tone (firstMissing=1) is lost. The next one must still
// acknowledge block zero and every completed block before five.
floor = applyCompactBlockStatus(acknowledged, floor, 12, { firstMissing: 5, bitmap: 0b0010 })
if (floor !== 5 || [0, 1, 2, 3, 4, 6].some(block => !acknowledged.has(block)) || acknowledged.has(5)) throw new Error('A lost compact ACK stranded completed blocks')
floor = applyCompactBlockStatus(acknowledged, floor, 12, { firstMissing: 7, bitmap: 0 })
if (floor !== 7 || !acknowledged.has(5) || acknowledged.has(7)) throw new Error('Cumulative block status did not advance')
floor = applyCompactBlockStatus(acknowledged, floor, 12, { firstMissing: 12, bitmap: 0 })
if (floor !== 12 || acknowledged.size !== 12) throw new Error('Final compact ACK did not cover the transfer')
console.log(JSON.stringify({ result: 'ok', recoveredLostAck: true, acknowledgedBlocks: acknowledged.size }))
