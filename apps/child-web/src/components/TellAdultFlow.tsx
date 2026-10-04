'use client';

import { CONSULT_CHOICES, type ChoiceRes, type ConsultChoice } from '@ijime/api-types';
import { Button, PetAvatar, SpeechBubble } from '@ijime/ui';
import { useState } from 'react';
import { COPY } from '@/lib/copy';
import { useChildStore } from '@/lib/store';
import { RequestError } from './RequestError';

export type TellAdultResult =
  { choice: 'self' } | { choice: 'proxy'; summary: string } | { choice: 'not_now' };

export function TellAdultFlow({
  onChoose,
  onFinished,
}: {
  onChoose: (r: TellAdultResult) => Promise<ChoiceRes>;
  onFinished: (choice: ConsultChoice) => void;
}) {
  const { gradeBand, characterId } = useChildStore();
  const copy = COPY[gradeBand].tell;
  const [step, setStep] = useState<'choose' | 'coach' | 'summary'>('choose');
  const [line, setLine] = useState(0);
  const [summary, setSummary] = useState('');
  const [script, setScript] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(result: TellAdultResult) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await onChoose(result);
      if (response.crisis) return;
      if (result.choice === 'self') {
        setScript(response.coachingScript ?? []);
        setStep('coach');
      } else onFinished(result.choice);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="mx-auto flex max-w-md flex-col items-center gap-5 px-4 py-6"
      data-testid="tell-adult"
      data-step={step}
    >
      <SpeechBubble tail="bottom" className="text-center">
        {/* Keep a stable element when page translators replace its text node. */}
        <span>
          {step === 'choose'
            ? copy.intro
            : step === 'coach'
              ? (script[line] ?? copy.coachDone)
              : copy.summaryTitle}
        </span>
      </SpeechBubble>
      <PetAvatar characterId={characterId ?? 'moko'} expression="caring" size={150} />
      <RequestError error={error} />
      {step === 'choose' && (
        <div className="flex w-full flex-col gap-3">
          {CONSULT_CHOICES.map((choice) => (
            <Button
              key={choice}
              size="xl"
              disabled={busy}
              variant={choice === 'not_now' ? 'ghost' : choice === 'proxy' ? 'calm' : 'primary'}
              data-testid={`choice-${choice}`}
              onClick={() => (choice === 'proxy' ? setStep('summary') : void submit({ choice }))}
            >
              {copy.choices[choice]}
            </Button>
          ))}
        </div>
      )}
      {step === 'coach' && (
        <div className="flex w-full flex-col gap-3">
          <p className="text-center text-sm text-ink-soft">{copy.coachTitle}</p>
          {line < script.length ? (
            <Button size="xl" data-testid="coach-next" onClick={() => setLine((l) => l + 1)}>
              つぎへ
            </Button>
          ) : (
            <Button
              size="xl"
              variant="calm"
              data-testid="coach-finish"
              onClick={() => onFinished('self')}
            >
              おわる
            </Button>
          )}
        </div>
      )}
      {step === 'summary' && (
        <div className="flex w-full flex-col gap-3">
          <label htmlFor="summary">{copy.summaryTitle}</label>
          <textarea
            id="summary"
            data-testid="summary-input"
            value={summary}
            disabled={busy}
            placeholder={copy.summaryPlaceholder}
            maxLength={120}
            rows={3}
            onChange={(e) => setSummary(e.target.value)}
            className="w-full rounded-card border-2 border-cream-deep bg-white px-4 py-3 leading-relaxed focus:border-calm focus:outline-none"
          />
          <Button
            size="xl"
            variant="calm"
            data-testid="summary-ok"
            disabled={busy || !summary.trim()}
            onClick={() => void submit({ choice: 'proxy', summary: summary.trim() })}
          >
            {copy.summaryOk}
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => setStep('choose')}>
            もどる
          </Button>
        </div>
      )}
    </div>
  );
}
