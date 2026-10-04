'use client';

import { Button } from '@ijime/ui';
import { useEffect, useRef } from 'react';

import { COPY } from '@/lib/copy';
import { useChildStore } from '@/lib/store';

export type Decoration = { artworkId: string; thumbnailUrl: string };

export function DecorationsDialog({
  decorations,
  onClose,
}: {
  decorations: Decoration[];
  onClose: () => void;
}) {
  const gradeBand = useChildStore((s) => s.gradeBand);
  const copy = COPY[gradeBand].home;
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    panelRef.current?.querySelector('button')?.focus();
  }, []);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="decorations-title"
      data-testid="decorations-dialog"
      className="fixed inset-0 z-40 flex items-center justify-center bg-ink/40 p-4"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <div
        ref={panelRef}
        className="max-h-[90dvh] w-full max-w-lg overflow-y-auto rounded-card bg-white p-5 shadow-lift"
      >
        <h2 id="decorations-title" className="font-display text-lg font-bold">
          {copy.decorations}
        </h2>
        {decorations.length === 0 ? (
          <p className="mt-3 leading-relaxed text-ink-soft" data-testid="decorations-empty">
            {copy.noDecorations}
          </p>
        ) : (
          <ul className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2" aria-label={copy.decorations}>
            {decorations.map((d, i) => (
              <li key={d.artworkId}>
                <img
                  src={d.thumbnailUrl}
                  alt={`${copy.decorations} ${i + 1}`}
                  className="aspect-square w-full rounded-card border border-cream-deep bg-white object-contain"
                  data-testid="decoration-large"
                />
              </li>
            ))}
          </ul>
        )}
        <Button
          className="mt-4 w-full"
          variant="secondary"
          data-testid="decorations-close"
          onClick={onClose}
        >
          {copy.close}
        </Button>
      </div>
    </div>
  );
}
