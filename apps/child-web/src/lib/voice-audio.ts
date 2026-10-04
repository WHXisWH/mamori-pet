export interface VoiceAudio {
  start(onPcm: (data: ArrayBuffer) => void): Promise<void>;
  play(data: ArrayBuffer): void;
  interrupt(): void;
  close(): void;
}

export function decodePcm16(data: ArrayBuffer): Float32Array<ArrayBuffer> {
  if (data.byteLength % 2 !== 0) throw new Error('invalid PCM frame');
  const view = new DataView(data);
  const samples = new Float32Array(data.byteLength / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
  return samples;
}

export class BrowserVoiceAudio implements VoiceAudio {
  private input?: AudioContext;
  private output?: AudioContext;
  private stream?: MediaStream;
  private capture?: AudioWorkletNode;
  private source?: MediaStreamAudioSourceNode;
  private muted?: GainNode;
  private scheduled = new Set<AudioBufferSourceNode>();
  private nextTime = 0;
  private closed = false;

  async start(onPcm: (data: ArrayBuffer) => void): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia || !globalThis.AudioContext)
      throw new Error('microphone unavailable');
    // Open audio contexts during the explicit user gesture; audio never enters storage.
    this.input = new AudioContext({ sampleRate: 16000 });
    this.output = new AudioContext({ sampleRate: 24000 });
    await this.input.resume();
    await this.output.resume();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      video: false,
    });
    if (this.closed) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    this.stream = stream;
    await this.input.audioWorklet.addModule('/voice-capture.js');
    if (this.closed) return;
    this.capture = new AudioWorkletNode(this.input, 'pcm-capture');
    this.capture.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      if (!this.closed) onPcm(event.data);
    };
    this.source = this.input.createMediaStreamSource(stream);
    this.muted = this.input.createGain();
    this.muted.gain.value = 0;
    this.source.connect(this.capture).connect(this.muted).connect(this.input.destination);
  }

  play(data: ArrayBuffer): void {
    if (this.closed || !this.output || data.byteLength === 0) return;
    const samples = decodePcm16(data);
    const output = this.output;
    // A stalled tab must not replay an unbounded backlog after it becomes active.
    if (this.nextTime - output.currentTime > 8) throw new Error('audio buffer exceeded');
    const buffer = output.createBuffer(1, samples.length, 24000);
    buffer.copyToChannel(samples, 0);
    const source = output.createBufferSource();
    source.buffer = buffer;
    source.connect(output.destination);
    this.scheduled.add(source);
    source.onended = () => {
      source.disconnect();
      this.scheduled.delete(source);
    };
    const startAt = Math.max(output.currentTime, this.nextTime);
    source.start(startAt);
    this.nextTime = startAt + buffer.duration;
  }

  interrupt(): void {
    for (const source of this.scheduled) {
      source.stop();
      source.disconnect();
    }
    this.scheduled.clear();
    this.nextTime = 0;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.interrupt();
    this.capture?.disconnect();
    this.source?.disconnect();
    this.muted?.disconnect();
    if (this.capture) this.capture.port.onmessage = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    void this.input?.close().catch(() => {});
    void this.output?.close().catch(() => {});
  }
}
