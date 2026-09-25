import { AudioPaceController } from './audio-pace.ts'

const pace = new AudioPaceController(15)
const current = () => pace.currentFps
if (!pace.update(4, 0, true) || current() !== 4) throw new Error('Calibrated rate was not applied before transmission')
if (pace.update(3, 2000, false) || current() !== 4) throw new Error('One low-quality audio report changed the rate')
if (pace.update(3, 4200, false) !== true || current() !== 3) throw new Error('Sustained loss did not lower the rate')
if (pace.update(6, 8000, false) || pace.update(6, 12000, false) || current() !== 3) throw new Error('Optical pace increased too aggressively')
if (!pace.update(6, 16500, false) || current() !== 6) throw new Error('Clean link did not recover a higher rate')
if (pace.update(0, 20000, false) || current() !== 6) throw new Error('Unknown audio pace changed the display')
console.log(JSON.stringify({ result: 'ok', calibratedFps: 4, recoveredFps: pace.currentFps }))
