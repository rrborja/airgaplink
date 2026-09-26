/** Fit the entire encoded frame without stretching cells or cropping finders. */
export function fitOpticalFrame(frameWidth: number, frameHeight: number, availableWidth: number, availableHeight: number) {
  if (![frameWidth, frameHeight, availableWidth, availableHeight].every(value => Number.isFinite(value) && value > 0)) throw new Error('Invalid optical frame layout')
  const scale = Math.min(availableWidth / frameWidth, availableHeight / frameHeight)
  return { width: Math.max(1, Math.floor(frameWidth * scale)), height: Math.max(1, Math.floor(frameHeight * scale)) }
}
