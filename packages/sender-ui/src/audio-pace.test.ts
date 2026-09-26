import { AudioPaceController } from './audio-pace.ts'

const pace = new AudioPaceController(15)
const current = () => pace.currentFps
if (!pace.update(4, 0, true) || current() !== 4) throw new Error('Calibrated rate was not applied before transmission')
if (pace.update(3, 2000, false) || current() !== 4) throw new Error('One low-quality audio report changed the rate')
if (pace.update(3, 3500, false) !== true || current() !== 3) throw new Error('Sustained loss did not lower the rate')
if (pace.update(6, 6000, false) || current() !== 3) throw new Error('One clean report increased the rate')
if (!pace.update(6, 8500, false) || current() !== 6) throw new Error('Clean link did not apply confirmed faster recommendation')
if (pace.update(8, 9000, false) || !pace.update(8, 14000, false) || current() !== 10) throw new Error('Sustained clean link did not continue climbing')
if (pace.update(1, 14500, false) || !pace.update(1, 17000, false) || current() !== 1) throw new Error('Sustained invalid frames did not apply confirmed backoff')
if (pace.update(0, 20000, false) || current() !== 1) throw new Error('Unknown audio pace changed the display')
const low = new AudioPaceController(2)
if (low.update(4, 1000, false) || !low.update(4, 2000, false) || low.currentFps !== 4) throw new Error('Confirmed low-FPS acceleration failed')
console.log(JSON.stringify({ result: 'ok', calibratedFps: 4, recoveredFps: pace.currentFps }))
