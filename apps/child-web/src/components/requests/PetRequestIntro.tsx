'use client';

import type { Expression, PetRequest } from '@ijime/api-types';
import { Button, PetAvatar, SpeechBubble } from '@ijime/ui';

import { REQUEST_COPY } from '@/lib/copy-requests';
import { useChildStore } from '@/lib/store';

import { ReadAloudButton, useAutoReadAloud } from './ReadAloudButton';
import { IslandSprite, islandItemLabel } from './sprite-fallback';

const EXPRESSION: Record<PetRequest['type'], Expression> = {
  drawing: 'happy',
  story: 'together',
  pet_worry: 'worried',
};

export function PetRequestIntro({
  request,
  onStart,
  busy = false,
}: {
  request: PetRequest;
  onStart: () => void;
  busy?: boolean;
}) {
  const { gradeBand, characterId } = useChildStore();
  const copy = REQUEST_COPY[gradeBand];
  const intro = copy.intro[request.type];
  useAutoReadAloud(`${intro} ${request.promptText}`);
  return (
    <div
      className="flex flex-col items-center gap-4 text-center"
      data-testid="pet-request-intro"
      data-type={request.type}
    >
      <div className="flex w-full items-start justify-center gap-2">
        <SpeechBubble tail="bottom" className="text-left">
          {intro}
        </SpeechBubble>
        <ReadAloudButton text={intro} className="shrink-0" />
      </div>
      <PetAvatar
        characterId={characterId ?? 'moko'}
        expression={EXPRESSION[request.type]}
        size={130}
      />
      <div
        className="flex w-full items-start gap-2 rounded-card bg-white p-4 text-left shadow-soft"
        data-testid="request-prompt"
      >
        <p className="font-display flex-1 text-lg font-bold leading-relaxed">
          {request.promptText}
        </p>
        <ReadAloudButton text={request.promptText} className="shrink-0" />
      </div>
      <div
        className="flex items-center gap-3 rounded-card bg-cream-deep/60 px-4 py-2 text-sm"
        data-testid="reward-preview"
      >
        <IslandSprite itemId={request.rewardItemId} size={44} />
        <span className="text-left leading-snug">
          {copy.rewardHint}
          <br />
          <span className="font-bold">{islandItemLabel(request.rewardItemId)}</span>
        </span>
      </div>
      <Button
        size="xl"
        className="w-full"
        data-testid="request-start"
        disabled={busy}
        onClick={onStart}
      >
        {copy.start[request.type]}
      </Button>
    </div>
  );
}
