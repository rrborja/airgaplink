/** Calibration sets the optical pace; it does not prove that encrypted block
 * zero reached durable receiver storage. Only the negotiated authenticated
 * manifest receipt can release the cyclic file stream. */
export function canBeginOpticalTransfer(calibrationSelected: boolean, manifestReceiptRequired: boolean, manifestReady: boolean, receiverPaused: boolean) {
  return calibrationSelected && !receiverPaused && (!manifestReceiptRequired || manifestReady)
}
