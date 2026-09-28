import assert from 'node:assert/strict'
import { canBeginOpticalTransfer } from './manifest-start-gate.ts'

assert.equal(canBeginOpticalTransfer(false, true, false, false), false)
assert.equal(canBeginOpticalTransfer(true, true, false, false), false, 'Calibration alone must not start file blocks')
assert.equal(canBeginOpticalTransfer(false, true, true, false), false, 'Manifest receipt alone must not skip calibration')
assert.equal(canBeginOpticalTransfer(true, true, true, true), false, 'Pause must block the start')
assert.equal(canBeginOpticalTransfer(true, true, true, false), true)
assert.equal(canBeginOpticalTransfer(true, false, false, false), true, 'An older peer keeps its previous start timing')
console.log(JSON.stringify({ result: 'ok', authenticatedManifestGate: true }))
