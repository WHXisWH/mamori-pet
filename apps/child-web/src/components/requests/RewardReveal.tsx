'use client';

import { Button } from '@ijime/ui';
import { useEffect, useState } from 'react';

import { REQUEST_COPY } from '@/lib/copy-requests';
import { useChildStore } from '@/lib/store';

import { FuriganaText } from '../FuriganaText';
import { useAutoReadAloud } from './ReadAloudButton';
import { IslandSprite, islandItemLabel } from './sprite-fallback';

type Phase = 'show' | 'placing' | 'placed';

export function RewardReveal({ itemId, onPlaced }: { itemId: string; onPlaced: () => void }) {
  const gradeBand = useChildStore((s) => s.gradeBand);
  const copy = REQUEST_COPY[gradeBand].reward;
  const [phase, setPhase] = useState<Phase>('show');
  const label = islandItemLabel(itemId);
  useAutoReadAloud(`${copy.title} ${label}`);

  useEffect(() => {
    const toPlacing = window.setTimeout(() => setPhase('placing'), 900);
    const toPlaced = window.setTimeout(() => setPhase('placed'), 1900);
    return () => {
      window.clearTimeout(toPlacing);
      window.clearTimeout(toPlaced);
    };
  }, []);

  const status = phase === 'show' ? copy.title : phase === 'placing' ? copy.placing : copy.placed;

  return (
    <div
      className="flex flex-col items-center gap-4 text-center"
      data-testid="reward-reveal"
      data-item={itemId}
      data-phase={phase}
    >
      <p role="status" aria-live="polite" className="font-display text-lg font-bold">
        <FuriganaText text={status} enabled={gradeBand === 'low'} />
      </p>
      <div className="relative flex h-56 w-full max-w-xs items-end justify-center">
        <svg
          aria-hidden="true"
          viewBox="0 0 240 90"
          className="absolute bottom-0 w-full"
          focusable="false"
        >
          <ellipse cx="120" cy="70" rx="112" ry="18" fill="#dbe7f3" />
          <ellipse cx="120" cy="60" rx="92" ry="22" fill="#7fb77e" />
          <ellipse cx="120" cy="54" rx="70" ry="14" fill="#a9d4a3" />
        </svg>
        <div
          className={`relative transition-all duration-700 ease-in-out ${
            phase === 'show'
              ? 'translate-y-[-96px] scale-110 animate-pop'
              : phase === 'placing'
                ? 'translate-y-[-20px] scale-100'
                : 'translate-y-[-20px] scale-100'
          }`}
        >
          <IslandSprite itemId={itemId} size={96} />
        </div>
      </div>
      <p className="text-xl font-bold" data-testid="reward-label">
        <FuriganaText text={label} enabled={gradeBand === 'low'} />
      </p>
      <Button
        size="xl"
        className="w-full"
        data-testid="reward-back"
        disabled={phase !== 'placed'}
        onClick={onPlaced}
      >
        {copy.back}
      </Button>
    </div>
  );
}
