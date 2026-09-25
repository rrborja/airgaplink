class OpticalMicProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0]?.[0]
    if (channel) {
      const copy = new Float32Array(channel)
      this.port.postMessage(copy.buffer, [copy.buffer])
    }
    // No microphone samples are copied to the output.
    return true
  }
}
registerProcessor('optical-mic', OpticalMicProcessor)
