import assert from 'node:assert/strict'
import { phoneCameraModes } from './phone-camera-optics.ts'

assert.deepEqual(phoneCameraModes(true)[0], { width: 2560, height: 1440, fps: 60 })
assert.deepEqual(phoneCameraModes(true)[1], { width: 2560, height: 1440, fps: 30 })
assert.deepEqual(phoneCameraModes(false)[0], { width: 1920, height: 1080, fps: 60 })
console.log(JSON.stringify({ result: 'ok', denseCaptureBounded: true }))
