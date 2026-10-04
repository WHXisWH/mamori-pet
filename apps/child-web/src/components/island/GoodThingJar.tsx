'use client';

import { Button } from '@ijime/ui';
import { useState } from 'react';

import { COPY } from '@/lib/copy';
import { useChildStore } from '@/lib/store';

export function GoodThingJar({
  count,
  doneToday,
  busy = false,
  onAdd,
  className = '',
}: {
  count: number;
  doneToday: boolean;
  busy?: boolean;
  onAdd: () => void;
  className?: string;
}) {
  const gradeBand = useChildStore((s) => s.gradeBand);
  const copy = COPY[gradeBand].home;
  const stars = Math.min(count, 12);
  return (
    <button
      type="button"
      data-testid="island-jar"
      data-count={count}
      data-done={doneToday}
      aria-label={`${doneToday ? copy.jarDone : copy.jar}。${copy.jarCount.replace('{n}', String(count))}`}
      aria-pressed={doneToday}
      aria-busy={busy}
      disabled={busy || doneToday}
      onClick={onAdd}
      className={`grade-tap tap-target flex flex-col items-center justify-end rounded-full p-1 transition hover:-translate-y-0.5 focus-visible:outline-4 focus-visible:outline-calm-deep disabled:opacity-100 ${className}`}
    >
      <svg viewBox="0 0 64 72" width="clamp(44px, 12vw, 64px)" aria-hidden="true">
        <rect x="22" y="2" width="20" height="8" rx="3" fill="#c9a37a" />
        <path
          d="M16 12 h32 a6 6 0 0 1 6 6 v44 a8 8 0 0 1 -8 8 h-28 a8 8 0 0 1 -8 -8 v-44 a6 6 0 0 1 6 -6 z"
          fill="#eaf3fb"
          stroke="#9fb1c4"
          strokeWidth="2"
        />
        {Array.from({ length: stars }, (_, i) => (
          <circle
            key={i}
            cx={18 + ((i * 11) % 30)}
            cy={62 - Math.floor(i / 3) * 10}
            r="3.5"
            fill="#f4c95d"
          />
        ))}
      </svg>
      <span
        aria-hidden="true"
        className={`-mt-1 rounded-full px-2 py-0.5 text-xs font-bold shadow-soft ${
          doneToday ? 'bg-calm-soft text-calm-deep' : 'bg-white/90 text-ink-soft'
        }`}
        data-testid="island-jar-count"
      >
        ⭐ {count}
      </span>
    </button>
  );
}

export function GoodThingNote({ onClose }: { onClose: () => void }) {
  const gradeBand = useChildStore((s) => s.gradeBand);
  const copy = COPY[gradeBand].home;
  const [text, setText] = useState('');
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="good-thing-title"
      data-testid="good-thing-note"
      className="fixed inset-0 z-40 flex items-end justify-center bg-ink/40 p-4 sm:items-center"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <div className="w-full max-w-md rounded-card bg-white p-5 shadow-lift">
        <p id="good-thing-title" className="font-display text-lg font-bold" role="status">
          ⭐ {copy.jarAdded}
        </p>
        <label className="mt-3 block text-sm text-ink-soft" htmlFor="good-thing-text">
          {copy.jarSay}
        </label>
        <textarea
          id="good-thing-text"
          data-testid="good-thing-text"
          value={text}
          maxLength={100}
          rows={2}
          placeholder={copy.jarPlaceholder}
          onChange={(e) => setText(e.target.value)}
          className="mt-1 w-full rounded-card border-2 border-cream-deep bg-white px-4 py-3 leading-relaxed focus:border-calm focus:outline-none"
        />
        <Button className="mt-3 w-full" data-testid="good-thing-close" onClick={onClose}>
          {copy.jarClose}
        </Button>
      </div>
    </div>
  );
}
