'use client';

import type { GradeBand } from '@ijime/api-types';
import { Button } from '@ijime/ui';
import { Mic, Pencil, Square } from 'lucide-react';
import { useState } from 'react';

import { REQUEST_COPY } from '@/lib/copy-requests';

import { ReadAloudButton } from './ReadAloudButton';
import { useSpeechRecognition } from './use-speech-recognition';

export type StoryEnding =
  { mode: 'typed' | 'voice_transcript' | 'option'; text: string } | { draw: true };

export function StoryEndingPicker({
  gradeBand,
  options,
  onDone,
  busy = false,
}: {
  gradeBand: GradeBand;
  options: { id: string; text: string }[];
  onDone: (ending: StoryEnding) => void;
  busy?: boolean;
}) {
  const copy = REQUEST_COPY[gradeBand];
  const [typed, setTyped] = useState('');
  const speech = useSpeechRecognition((text) => onDone({ mode: 'voice_transcript', text }));
  const voiceSupported = speech.status !== 'unsupported' && speech.status !== 'unknown';
  const showTyped = gradeBand !== 'low' || speech.status === 'unsupported';
  const listening = speech.status === 'listening';

  return (
    <div className="flex flex-col gap-4" data-testid="story-ending-picker" data-grade={gradeBand}>
      <p className="font-display text-center text-lg font-bold">{copy.story.pickTitle}</p>
      <div role="group" aria-label={copy.story.pickTitle} className="flex flex-col gap-3">
        {options.map((option) => (
          <div key={option.id} className="flex items-stretch gap-2">
            <button
              type="button"
              data-testid={`story-option-${option.id}`}
              disabled={busy || listening}
              onClick={() => onDone({ mode: 'option', text: option.text })}
              className="grade-tap tap-target flex-1 rounded-card border-4 border-transparent bg-white px-4 py-4 text-left text-lg font-bold leading-relaxed shadow-soft transition hover:-translate-y-0.5 hover:border-calm hover:shadow-lift focus-visible:outline-4 focus-visible:outline-calm-deep disabled:opacity-50"
            >
              {option.text}
            </button>
            <ReadAloudButton text={option.text} className="self-center" />
          </div>
        ))}
      </div>

      {speech.status === 'unsupported' && (
        <p
          role="status"
          data-testid="story-voice-unsupported"
          className="rounded-card bg-cream-deep/70 px-4 py-3 text-sm leading-relaxed"
        >
          {copy.voice.unsupported}
        </p>
      )}
      {speech.error && speech.status !== 'listening' && (
        <p role="status" data-testid="story-voice-error" className="text-sm text-ink-soft">
          {speech.error === 'denied' ? copy.voice.denied : copy.voice.nothing}
        </p>
      )}
      {listening && (
        <p
          role="status"
          aria-live="polite"
          data-testid="story-voice-listening"
          className="text-center"
        >
          {copy.voice.listening}
          {speech.interim && <span className="block text-ink-soft">{speech.interim}</span>}
        </p>
      )}

      {showTyped && (
        <div className="flex flex-col gap-2">
          <label className="sr-only" htmlFor="story-ending-typed">
            {copy.story.typePlaceholder}
          </label>
          <textarea
            id="story-ending-typed"
            data-testid="story-ending-input"
            value={typed}
            disabled={busy || listening}
            maxLength={200}
            rows={2}
            placeholder={copy.story.typePlaceholder}
            onChange={(e) => setTyped(e.target.value)}
            className="w-full rounded-card border-2 border-cream-deep bg-white px-4 py-3 leading-relaxed focus:border-calm focus:outline-none"
          />
          <Button
            data-testid="story-ending-typed-done"
            disabled={busy || listening || typed.trim().length === 0}
            onClick={() => onDone({ mode: 'typed', text: typed.trim() })}
          >
            {copy.story.typeDone}
          </Button>
        </div>
      )}

      <div className="flex flex-col gap-2 sm:flex-row">
        {voiceSupported && (
          <Button
            variant={listening ? 'calm' : 'secondary'}
            className="flex-1"
            data-testid={listening ? 'story-voice-stop' : 'story-voice-start'}
            disabled={busy}
            aria-pressed={listening}
            onClick={() => (listening ? speech.stop() : speech.start())}
          >
            {listening ? <Square size={20} aria-hidden /> : <Mic size={20} aria-hidden />}
            {listening ? copy.voice.stop : copy.story.voice}
          </Button>
        )}
        <Button
          variant="secondary"
          className="flex-1"
          data-testid="story-draw"
          disabled={busy || listening}
          onClick={() => onDone({ draw: true })}
        >
          <Pencil size={20} aria-hidden />
          {copy.story.draw}
        </Button>
      </div>
    </div>
  );
}
