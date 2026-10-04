'use client';

import { Button, PetAvatar, SpeechBubble } from '@ijime/ui';
import { Keyboard, Mic, Square } from 'lucide-react';
import { useState } from 'react';

import { COPY } from '@/lib/copy';
import { REQUEST_COPY } from '@/lib/copy-requests';
import { useChildStore } from '@/lib/store';

import { useSpeechRecognition } from './requests/use-speech-recognition';

export type Narrative = { mode: 'typed' | 'voice_transcript'; text: string };

export function NarrativeRecorder({
  voiceEnabled,
  prompt,
  onDone,
  busy = false,
  defaultMode = 'typed',
}: {
  voiceEnabled: boolean;
  prompt?: string;
  onDone: (n: Narrative | null) => void;
  busy?: boolean;
  defaultMode?: 'voice' | 'typed';
}) {
  const { gradeBand, characterId } = useChildStore();
  const copy = COPY[gradeBand].narrative;
  const voiceCopy = REQUEST_COPY[gradeBand].voice;
  const [text, setText] = useState('');
  const [source, setSource] = useState<Narrative['mode']>('typed');
  const [mode, setMode] = useState<'voice' | 'typed'>(voiceEnabled ? defaultMode : 'typed');
  const speech = useSpeechRecognition((transcript) => {
    setText((prev) => (prev ? `${prev} ${transcript}` : transcript));
    setSource('voice_transcript');
  });
  const voiceSupported = voiceEnabled && speech.status !== 'unsupported';
  const voiceMode = mode === 'voice' && voiceSupported && speech.status !== 'unknown';
  const listening = speech.status === 'listening';
  const unsupportedHint =
    voiceEnabled && defaultMode === 'voice' && speech.status === 'unsupported';

  return (
    <div
      className="flex flex-col items-center gap-4"
      data-testid="narrative-recorder"
      data-mode={voiceMode ? 'voice' : 'typed'}
    >
      <SpeechBubble tail="bottom" className="text-center">
        {prompt ?? copy.title}
      </SpeechBubble>
      <PetAvatar characterId={characterId ?? 'moko'} expression="caring" size={120} />
      {unsupportedHint && (
        <p
          role="status"
          data-testid="narrative-voice-unsupported"
          className="w-full rounded-card bg-cream-deep/70 px-4 py-3 text-sm leading-relaxed"
        >
          {voiceCopy.unsupported}
        </p>
      )}
      {voiceMode && (
        <div className="flex w-full flex-col items-center gap-2">
          <Button
            variant={listening ? 'calm' : 'primary'}
            size="xl"
            className="w-full"
            data-testid={listening ? 'narrative-voice-stop' : 'narrative-voice-start'}
            aria-pressed={listening}
            disabled={busy}
            onClick={() => (listening ? speech.stop() : speech.start())}
          >
            {listening ? <Square size={22} aria-hidden /> : <Mic size={22} aria-hidden />}
            {listening ? voiceCopy.stop : voiceCopy.start}
          </Button>
          {listening && (
            <p role="status" aria-live="polite" data-testid="narrative-voice-listening">
              {voiceCopy.listening}
              {speech.interim && <span className="block text-ink-soft">{speech.interim}</span>}
            </p>
          )}
          {speech.error && !listening && (
            <p role="status" data-testid="narrative-voice-error" className="text-sm text-ink-soft">
              {speech.error === 'denied' ? voiceCopy.denied : voiceCopy.nothing}
            </p>
          )}
        </div>
      )}
      <label className="sr-only" htmlFor="narrative">
        {copy.title}
      </label>
      <textarea
        id="narrative"
        data-testid="narrative-input"
        value={text}
        disabled={busy || listening}
        maxLength={500}
        rows={3}
        placeholder={copy.placeholder}
        onChange={(e) => {
          setText(e.target.value);
          setSource('typed');
        }}
        className="w-full rounded-card border-2 border-cream-deep bg-white px-4 py-3 leading-relaxed focus:border-calm focus:outline-none"
      />
      <div className="flex w-full flex-col gap-2 sm:flex-row">
        <Button
          className="flex-1"
          data-testid="narrative-done"
          disabled={busy || listening || text.trim().length === 0}
          onClick={() => onDone({ mode: source, text: text.trim() })}
        >
          {copy.done}
        </Button>
        {voiceSupported && speech.status !== 'unknown' && (
          <Button
            variant="secondary"
            className="flex-1"
            data-testid={voiceMode ? 'narrative-mode-typed' : 'narrative-mode-voice'}
            disabled={busy || listening}
            onClick={() => setMode(voiceMode ? 'typed' : 'voice')}
          >
            {voiceMode ? <Keyboard size={20} aria-hidden /> : <Mic size={20} aria-hidden />}
            {voiceMode ? voiceCopy.typeInstead : voiceCopy.voiceInstead}
          </Button>
        )}
        <Button
          variant="ghost"
          className="flex-1"
          data-testid="narrative-skip"
          disabled={busy || listening}
          onClick={() => onDone(null)}
        >
          {copy.skip}
        </Button>
      </div>
    </div>
  );
}
