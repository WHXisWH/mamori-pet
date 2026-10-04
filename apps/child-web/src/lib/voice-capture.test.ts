// @vitest-environment node
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

describe('microphone worklet', () => {
  for (const inputRate of [16000, 44100, 48000]) {
    it(`emits 40 ms signed little-endian 16 kHz frames from ${inputRate} Hz input`, () => {
      const postMessage = vi.fn();
      let Capture!: new () => { process(input: Float32Array[][]): boolean };
      const source = readFileSync(
        new URL('../../public/voice-capture.js', import.meta.url),
        'utf8',
      );
      runInNewContext(source, {
        AudioWorkletProcessor: class {
          port = { postMessage };
        },
        sampleRate: inputRate,
        registerProcessor: (_name: string, value: typeof Capture) => {
          Capture = value;
        },
      });
      const capture = new Capture();
      for (let i = 0; i < inputRate; i += 128) {
        const samples = new Float32Array(Math.min(128, inputRate - i)).fill(-1);
        expect(capture.process([[samples]])).toBe(true);
      }
      expect(postMessage).toHaveBeenCalledTimes(25);
      for (const [frame] of postMessage.mock.calls) {
        expect(frame.byteLength).toBe(1280);
        expect(new DataView(frame).getInt16(0, true)).toBe(-32768);
      }
    });
  }
});
