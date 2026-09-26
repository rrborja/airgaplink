import { fitOpticalFrame } from './optical-layout.ts'

const availableWidth = 1920 - 24, availableHeight = 1080 - 72
const narrow = fitOpticalFrame(232, 152, availableWidth, availableHeight)
const wide = fitOpticalFrame(272, 152, availableWidth, availableHeight)
if (narrow.width > availableWidth || narrow.height > availableHeight || wide.width > availableWidth || wide.height > availableHeight) throw new Error('Fullscreen optical frame was cropped')
if (wide.width <= narrow.width || wide.width < availableWidth * 0.9 || wide.height !== narrow.height) throw new Error('Wide profile did not use the available side space at the same cell height')
const portrait = fitOpticalFrame(272, 152, 850, 1000)
if (portrait.width !== 850 || portrait.height > 1000) throw new Error('Narrow viewport did not constrain optical width')
console.log(JSON.stringify({ result: 'ok', narrowWidth: narrow.width, wideWidth: wide.width }))
