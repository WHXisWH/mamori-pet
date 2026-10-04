import { expect, it } from 'vitest';
import { decodePcm16 } from './voice-audio';

it('decodes signed little-endian PCM and rejects incomplete samples', () => {
  const bytes = new Uint8Array([0, 128, 0, 0, 255, 127]);
  const samples = decodePcm16(bytes.buffer);
  expect(Array.from(samples)).toEqual([-1, 0, 32767 / 32768]);
  expect(() => decodePcm16(new ArrayBuffer(3))).toThrow('invalid PCM frame');
});
