'use client';

import { REQUEST_COPY } from '@/lib/copy-requests';
import { useChildStore } from '@/lib/store';

import { ReadAloudButton } from './ReadAloudButton';

export function WorryOptions({
  options,
  onPick,
  busy = false,
}: {
  options: { id: string; text: string }[];
  onPick: (optionId: string) => void;
  busy?: boolean;
}) {
  const gradeBand = useChildStore((s) => s.gradeBand);
  const copy = REQUEST_COPY[gradeBand].worry;
  return (
    <div className="flex flex-col gap-3" data-testid="worry-options">
      <p className="font-display text-center text-lg font-bold">{copy.title}</p>
      <div role="group" aria-label={copy.title} className="flex flex-col gap-3">
        {options.map((option) => (
          <div key={option.id} className="flex items-stretch gap-2">
            <button
              type="button"
              data-testid={`worry-option-${option.id}`}
              disabled={busy}
              onClick={() => onPick(option.id)}
              className="grade-tap tap-target flex-1 rounded-card border-4 border-transparent bg-white px-4 py-4 text-left text-lg font-bold leading-relaxed shadow-soft transition hover:-translate-y-0.5 hover:border-calm hover:shadow-lift focus-visible:outline-4 focus-visible:outline-calm-deep disabled:opacity-50"
            >
              {option.text}
            </button>
            <ReadAloudButton text={option.text} className="self-center" />
          </div>
        ))}
      </div>
    </div>
  );
}
