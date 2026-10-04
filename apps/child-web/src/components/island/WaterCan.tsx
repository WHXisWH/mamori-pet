'use client';

import { COPY } from '@/lib/copy';
import { useChildStore } from '@/lib/store';

import { IslandSprite } from './sprites';

export function WaterCan({
  doneToday,
  busy = false,
  onWater,
  className = '',
}: {
  doneToday: boolean;
  busy?: boolean;
  onWater: () => void;
  className?: string;
}) {
  const gradeBand = useChildStore((s) => s.gradeBand);
  const copy = COPY[gradeBand].home;
  return (
    <button
      type="button"
      data-testid="island-plant"
      data-watered={doneToday}
      aria-label={doneToday ? copy.watered : copy.plant}
      aria-pressed={doneToday}
      aria-busy={busy}
      disabled={busy}
      onClick={onWater}
      className={`grade-tap tap-target group flex flex-col items-center justify-end rounded-full p-1 transition hover:-translate-y-0.5 focus-visible:outline-4 focus-visible:outline-calm-deep ${className}`}
    >
      <IslandSprite id="flower_red" size="clamp(44px, 12vw, 64px)" />
      <span
        aria-hidden="true"
        className={`-mt-1 rounded-full px-2 py-0.5 text-xs font-bold shadow-soft ${
          doneToday ? 'bg-calm-soft text-calm-deep' : 'bg-white/90 text-ink-soft'
        }`}
      >
        {doneToday ? '💧✓' : '💧'}
      </span>
    </button>
  );
}
