class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Int16Array(640);
    this.index = 0;
    this.phase = 0;
    this.sum = 0;
    this.count = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    for (const sample of input) {
      this.sum += sample;
      this.count++;
      this.phase += 16000;
      if (this.phase < sampleRate) continue;
      this.phase -= sampleRate;
      const value = Math.max(-1, Math.min(1, this.sum / this.count));
      this.samples[this.index++] = Math.round(value * (value < 0 ? 32768 : 32767));
      this.sum = 0;
      this.count = 0;
      if (this.index === this.samples.length) {
        const bytes = new ArrayBuffer(this.samples.length * 2);
        const view = new DataView(bytes);
        for (let i = 0; i < this.samples.length; i++) view.setInt16(i * 2, this.samples[i], true);
        this.port.postMessage(bytes, [bytes]);
        this.index = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCapture);
