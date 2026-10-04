import { expect, it, vi } from 'vitest';
import { readLocally } from './read-aloud';

it('uses a local Japanese voice, not the first remote or English voice', () => {
  const voices = [
    { lang: 'ja-JP', localService: false },
    { lang: 'en-US', localService: true },
    { lang: 'ja-JP', localService: true },
  ] as SpeechSynthesisVoice[];
  const speech = { cancel: vi.fn(), speak: vi.fn(), getVoices: () => voices };
  expect(
    readLocally(
      'こんにちは',
      speech as unknown as SpeechSynthesis,
      (text) => ({ text }) as SpeechSynthesisUtterance,
    ),
  ).toBe(true);
  expect(speech.cancel).toHaveBeenCalledOnce();
  expect(speech.speak).toHaveBeenCalledWith(
    expect.objectContaining({ text: 'こんにちは', voice: voices[2], lang: 'ja-JP' }),
  );
});

it.each([
  { voices: [] },
  { voices: [{ lang: 'ja-JP', localService: false }] },
  { voices: [{ lang: 'en-US', localService: true }] },
])(
  'does not send a reply to another provider when local Japanese speech is unavailable',
  ({ voices }) => {
    const speech = { cancel: vi.fn(), speak: vi.fn(), getVoices: () => voices };
    expect(readLocally('private reply', speech as unknown as SpeechSynthesis)).toBe(false);
    expect(speech.speak).not.toHaveBeenCalled();
  },
);

it('returns unavailable when browser speech fails instead of breaking text chat', () => {
  const speech = {
    cancel: vi.fn(),
    getVoices: () => [{ lang: 'ja-JP', localService: true }],
    speak: () => {
      throw new Error('device_speech_failed');
    },
  };
  expect(
    readLocally(
      'こんにちは',
      speech as unknown as SpeechSynthesis,
      (text) => ({ text }) as SpeechSynthesisUtterance,
    ),
  ).toBe(false);
});
