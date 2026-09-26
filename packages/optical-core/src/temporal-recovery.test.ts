import { DEBUG_PROFILE, TemporalOpticalRecovery, crc32, decodeOpticalCells, deterministicPayload, encodeOpticalFrame } from './index.ts'

const payload = deterministicPayload(817, 256)
const frame = encodeOpticalFrame(payload, 17, 4, DEBUG_PROFILE)
const failures = [3, 47, 101].map(cell => {
  const cells = frame.cells.slice()
  cells[(16 + Math.floor(cell / DEBUG_PROFILE.gridWidth)) * frame.width + 16 + cell % DEBUG_PROFILE.gridWidth] ^= 1
  const result = decodeOpticalCells(cells, DEBUG_PROFILE)
  if (result.ok || result.reason !== 'payload-crc' || !result.candidatePayload || result.candidatePayload.length !== payload.length) throw new Error('CRC failure did not retain a bounded local candidate')
  return result
})
const recovery = new TemporalOpticalRecovery(crc32)
if (recovery.add(failures[0], 0) || recovery.add(failures[0], 10) || recovery.lastCandidateCount !== 1) throw new Error('Duplicate camera sample was counted twice')
if (recovery.add(failures[1], 20)) throw new Error('Incomplete temporal group was accepted')
const restored = recovery.add(failures[2], 30)
if (!restored?.ok || restored.recovery !== 'temporal-majority' || restored.payload.some((value, index) => value !== payload[index])) throw new Error('Independent optical bit errors were not recovered exactly')
const stale = new TemporalOpticalRecovery(crc32)
stale.add(failures[0], 0); stale.add(failures[1], 100)
if (stale.add(failures[2], 16000)) throw new Error('Expired camera candidates were combined')
const mixed = new TemporalOpticalRecovery(crc32)
mixed.add(failures[0], 0)
const other = encodeOpticalFrame(deterministicPayload(818, 256), 22, 4, DEBUG_PROFILE)
const otherCells = other.cells.slice()
otherCells[16 * other.width + 16] ^= 1
const otherFailure = decodeOpticalCells(otherCells, DEBUG_PROFILE)
if (otherFailure.ok || mixed.add(otherFailure, 10) || mixed.lastCandidateCount !== 1) throw new Error('Different optical payloads were mixed')
mixed.clear()
if (mixed.add(failures[1], 20) || mixed.lastCandidateCount !== 1) throw new Error('Cancelled optical session retained candidates')
console.log(JSON.stringify({ result: 'ok', recoveredFrames: recovery.recovered }))
