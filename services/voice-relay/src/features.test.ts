import { describe, expect, it } from 'vitest';

import { analyzeUtterance, pitchHz, speechRate, toSamples, VadSegmenter } from './features.js';
import { countKanaMorae, countMorae } from './mora.js';

const RATE = 16000;
const FRAME = 640; // 40ms

function sine(hz: number, ms: number, amp = 8000): Buffer {
  const n = (RATE * ms) / 1000;
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++)
    b.writeInt16LE(Math.round(amp * Math.sin((2 * Math.PI * hz * i) / RATE)), i * 2);
  return b;
}
const silence = (ms: number) => Buffer.alloc(((RATE * ms) / 1000) * 2);
const frames = (b: Buffer) => {
  const out: Buffer[] = [];
  for (let i = 0; i < b.length; i += FRAME * 2) out.push(b.subarray(i, i + FRAME * 2));
  return out;
};

describe('pitchHz', () => {
  it.each([120, 200, 310])('finds %d Hz within ±5', (hz) => {
    expect(Math.abs(pitchHz(toSamples(sine(hz, 40)))! - hz)).toBeLessThanOrEqual(5);
  });

  it('returns null for silence and noise', () => {
    expect(pitchHz(toSamples(silence(40)))).toBeNull();
    let seed = 3;
    const noise = Buffer.alloc(FRAME * 2);
    for (let i = 0; i < FRAME; i++) {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      noise.writeInt16LE((seed % 16000) - 8000, i * 2);
    }
    expect(pitchHz(toSamples(noise))).toBeNull();
  });
});

describe('analyzeUtterance', () => {
  it('all silence has a pause ratio of 1 and no pitch', () => {
    const f = frames(silence(1000)).map(toSamples);
    const r = analyzeUtterance({ frames: f, speech: f.map(() => false) });
    expect(r.pauseRatio).toBe(1);
    expect(r.durationMs).toBe(1000);
    expect(r.pitchMeanHz).toBeUndefined();
  });

  it('measures a 200 Hz tone', () => {
    const f = frames(sine(200, 800)).map(toSamples);
    const r = analyzeUtterance({ frames: f, speech: f.map(() => true) });
    expect(Math.abs(r.pitchMeanHz! - 200)).toBeLessThanOrEqual(5);
    expect(r.pitchStdHz!).toBeLessThan(2);
    expect(r.pauseRatio).toBe(0);
  });
});

describe('VadSegmenter', () => {
  it('cuts one utterance with exact duration and inner pause, trimming the trailing silence', () => {
    const vad = new VadSegmenter();
    const audio = Buffer.concat([
      silence(400),
      sine(180, 1000),
      silence(400),
      sine(180, 600),
      silence(1000),
    ]);
    const events = frames(audio).flatMap((f) => vad.push(f));
    expect(events.map((e) => e.type)).toEqual(['speech_start', 'utterance']);
    const u = events.find((e) => e.type === 'utterance')!;
    if (u.type !== 'utterance') throw new Error('unreachable');
    const r = analyzeUtterance(u.utterance);
    expect(r.durationMs).toBe(2000);
    expect(r.pauseRatio).toBeCloseTo(0.2, 5);
  });

  it('ignores blips shorter than the minimum utterance', () => {
    const vad = new VadSegmenter();
    const events = frames(Buffer.concat([sine(200, 120), silence(1000)])).flatMap((f) =>
      vad.push(f),
    );
    expect(events.map((e) => e.type)).toEqual(['speech_start']);
  });

  it('flushes an unfinished utterance', () => {
    const vad = new VadSegmenter();
    frames(sine(200, 600)).forEach((f) => vad.push(f));
    expect(vad.flush().map((e) => e.type)).toEqual(['utterance']);
    expect(vad.inUtterance).toBe(false);
  });

  it('drops oversized acoustic samples instead of accumulating unbounded audio', () => {
    const vad = new VadSegmenter(undefined, 40, 20);
    const events = frames(Buffer.concat([sine(200, 4000), silence(1000)])).flatMap((f) =>
      vad.push(f),
    );
    expect(events.map((event) => event.type)).toEqual(['speech_start']);
    expect(vad.inUtterance).toBe(false);
    frames(sine(200, 600)).forEach((frame) => vad.push(frame));
    expect(vad.flush().map((event) => event.type)).toEqual(['utterance']);
  });
});

describe('morae', () => {
  it.each([
    ['きょう', 2],
    ['がっこう', 4],
    ['コーヒー', 4],
    ['しんぶん', 4],
    ['ちょっと', 3],
  ])('kana %s → %d', (kana, n) => {
    expect(countKanaMorae(kana)).toBe(n);
  });

  it.each([
    ['今日は学校に行った', 11],
    ['東京', 4],
    ['きょうは がっこうに いった。', 11],
    ['ＡＢＣ', 0],
  ])('text %s → %d', async (text, n) => {
    expect(await countMorae(text)).toBe(n);
  });

  it('speech rate is morae per second', () => {
    expect(speechRate(11, 2000)).toBe(5.5);
    expect(speechRate(3, 0)).toBe(0);
  });
});
