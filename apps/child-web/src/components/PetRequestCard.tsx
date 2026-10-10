'use client';

import type { PetRequest } from '@ijime/api-types';
import { Button, Card } from '@ijime/ui';
import Link from 'next/link';

import { IslandSprite } from '@/components/island/sprites';
import { COPY } from '@/lib/copy';
import { useChildStore } from '@/lib/store';
import { FuriganaText } from './FuriganaText';
import { ReadAloudButton } from './requests/ReadAloudButton';

export function PetRequestCard({
  request,
  busy = false,
  onDecline,
}: {
  request: PetRequest;
  busy?: boolean;
  onDecline: () => void;
}) {
  const gradeBand = useChildStore((s) => s.gradeBand);
  const copy = COPY[gradeBand].request;
  const headingId = `pet-request-${request.requestId}`;
  return (
    <Card
      role="region"
      aria-labelledby={headingId}
      data-testid="pet-request-card"
      data-request-id={request.requestId}
      data-type={request.type}
      className="mx-4 flex flex-col gap-3 text-ink"
    >
      <div className="flex flex-col items-start gap-3 sm:flex-row sm:justify-between">
        <div className="min-w-0 w-full flex-1">
          <p id={headingId} className="text-sm font-bold text-ink-soft">
            <span aria-hidden="true">💌 </span>
            {copy.heading[request.type]}
          </p>
          <p className="mt-1 font-display text-lg leading-relaxed font-bold" lang="ja">
            <FuriganaText text={request.promptText} enabled={gradeBand === 'low'} />
          </p>
          <ReadAloudButton text={request.promptText} className="mt-1" />
        </div>
        <div
          className="flex shrink-0 items-center gap-2 rounded-card bg-cream px-2 py-1 sm:flex-col sm:gap-0"
          data-testid="pet-request-reward"
          data-item={request.rewardItemId}
        >
          <IslandSprite id={request.rewardItemId} size={48} />
          <span className="text-[0.7rem] font-bold text-ink-soft">{copy.reward}</span>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Link
          href={`/requests/${encodeURIComponent(request.requestId)}`}
          data-testid="pet-request-open"
          className="grade-tap tap-target inline-flex flex-1 items-center justify-center gap-2 rounded-full bg-leaf px-6 py-3 text-lg font-bold text-white shadow-soft transition hover:bg-leaf-deep focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-calm-deep"
        >
          {copy.open}
        </Link>
        <Button
          variant="ghost"
          className="flex-1"
          disabled={busy}
          data-testid="pet-request-decline"
          onClick={onDecline}
        >
          {copy.decline}
        </Button>
      </div>
    </Card>
  );
}
