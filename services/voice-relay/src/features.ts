import { voice as voiceConfig } from '@ijime/config';

// 音声特徴。16kHz 16-bit モノラルの PCM をメモリ上でだけ処理し、計算が済んだら捨てる。
const RATE = voiceConfig.inputSampleRateHz;

export function toSamples(frame: Buffer): Int16Array {
  const out = new Int16Array(Math.floor(frame.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = frame.readInt16LE(i * 2);
  return out;
}

export function rmsDbfs(samples: Int16Array): number {
  if (!samples.length) return -Infinity;
  let sum = 0;
  for (const s of samples) sum += s * s;
  const rms = Math.sqrt(sum / samples.length) / 32768;
  return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}

// 正規化自己相関で基本周波数を求める。周期性が足りない（有声音でない）ときは null を返す
export function pitchHz(
  samples: Int16Array,
  range: { min: number; max: number } = voiceConfig.pitchRangeHz,
): number | null {
  const minLag = Math.floor(RATE / range.max);
  const maxLag = Math.min(Math.ceil(RATE / range.min), samples.length - 1);
  let energy = 0;
  for (const s of samples) energy += s * s;
  if (energy === 0 || maxLag <= minLag) return null;
  let bestLag = 0;
  let best = 0;
  const corr = new Float64Array(maxLag + 2);
  for (let lag = minLag; lag <= maxLag + 1 && lag < samples.length; lag++) {
    let c = 0;
    for (let i = 0; i + lag < samples.length; i++) c += samples[i]! * samples[i + lag]!;
    corr[lag] = c / energy;
  }
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (corr[lag]! > best && corr[lag]! >= corr[lag - 1]! && corr[lag]! >= corr[lag + 1]!) {
      best = corr[lag]!;
      bestLag = lag;
    }
  }
  if (best < 0.5 || !bestLag) return null;
  // 放物線補間で、整数ラグの間の推定精度を上げる
  const a = corr[bestLag - 1]!;
  const b = corr[bestLag]!;
  const c = corr[bestLag + 1]!;
  const denom = a - 2 * b + c;
  const shift = denom === 0 ? 0 : (0.5 * (a - c)) / denom;
  return RATE / (bestLag + shift);
}

export type Utterance = { frames: Int16Array[]; speech: boolean[] };

export type UtteranceFeatures = {
  durationMs: number;
  pauseRatio: number;
  pitchMeanHz?: number;
  pitchStdHz?: number;
};

export function analyzeUtterance(
  u: Utterance,
  frameMs: number = voiceConfig.frameMs,
): UtteranceFeatures {
  const total = u.frames.length;
  const silent = u.speech.filter((s) => !s).length;
  const pitches = u.frames
    .filter((_f, i) => u.speech[i])
    .map((f) => pitchHz(f))
    .filter((p): p is number => p !== null);
  const out: UtteranceFeatures = {
    durationMs: total * frameMs,
    pauseRatio: total ? silent / total : 1,
  };
  if (pitches.length) {
    const mean = pitches.reduce((s, p) => s + p, 0) / pitches.length;
    const variance = pitches.reduce((s, p) => s + (p - mean) ** 2, 0) / pitches.length;
    out.pitchMeanHz = mean;
    out.pitchStdHz = Math.sqrt(variance);
  }
  return out;
}

export function speechRate(morae: number, durationMs: number): number {
  return durationMs > 0 ? morae / (durationMs / 1000) : 0;
}

export type VadEvent = { type: 'speech_start' } | { type: 'utterance'; utterance: Utterance };

// フレームのエネルギーで発話を区切る：最初の音声フレームで発話を開始し、無音が endSilenceMs 続いたら終了する（末尾の無音は含めない）
export class VadSegmenter {
  private current: Utterance | null = null;
  private silenceRun = 0;
  private truncated = false;

  constructor(
    private readonly cfg: {
      speechRmsDbfs: number;
      endSilenceMs: number;
      minUtteranceMs: number;
    } = voiceConfig.vad,
    private readonly frameMs: number = voiceConfig.frameMs,
    private readonly maxFrames: number = Math.ceil(60_000 / frameMs),
  ) {}

  get inUtterance(): boolean {
    return this.current !== null;
  }

  push(frame: Buffer): VadEvent[] {
    const samples = toSamples(frame);
    const speech = rmsDbfs(samples) >= this.cfg.speechRmsDbfs;
    if (!this.current) {
      if (!speech) return [];
      this.current = { frames: [samples], speech: [true] };
      this.silenceRun = 0;
      return [{ type: 'speech_start' }];
    }
    if (!this.truncated && this.current.frames.length >= this.maxFrames) {
      this.current.frames = [];
      this.current.speech = [];
      this.truncated = true;
    }
    if (!this.truncated) {
      this.current.frames.push(samples);
      this.current.speech.push(speech);
    }
    this.silenceRun = speech ? 0 : this.silenceRun + 1;
    if (this.silenceRun * this.frameMs < this.cfg.endSilenceMs) return [];
    return this.finish();
  }

  // セッション終了時に、話し終えていない発話も切り出す
  flush(): VadEvent[] {
    return this.current ? this.finish() : [];
  }

  discard(): void {
    this.current = null;
    this.silenceRun = 0;
    this.truncated = false;
  }

  private finish(): VadEvent[] {
    const u = this.current!;
    this.current = null;
    if (this.truncated) {
      // An incomplete acoustic sample must not be reported as a complete utterance.
      this.discard();
      return [];
    }
    const keep = u.frames.length - this.silenceRun;
    this.silenceRun = 0;
    const trimmed: Utterance = { frames: u.frames.slice(0, keep), speech: u.speech.slice(0, keep) };
    const speechMs = trimmed.speech.filter(Boolean).length * this.frameMs;
    if (speechMs < this.cfg.minUtteranceMs) return [];
    return [{ type: 'utterance', utterance: trimmed }];
  }
}
