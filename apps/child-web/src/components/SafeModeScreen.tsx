'use client';

import type { HelpResource } from '@ijime/api-types';
import { Button, PetAvatar } from '@ijime/ui';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import safeCopy from '@/generated/safe_mode.json';
import { COPY } from '@/lib/copy';
import { useChildStore } from '@/lib/store';

function telHref(phone: string): string {
  return `tel:${phone.split('/')[0]!.replace(/[^\d+]/g, '')}`;
}

export function SafeModeScreen({
  message,
  resources,
  familyHarm = false,
}: {
  message?: string | undefined;
  resources: HelpResource[];
  familyHarm?: boolean;
}) {
  const { gradeBand, characterId } = useChildStore();
  const copy = COPY[gradeBand].safe;
  const router = useRouter();
  const [adultNear, setAdultNear] = useState<boolean | null>(null);
  const [confirming, setConfirming] = useState(false);
  const lines = (familyHarm ? safeCopy.family_harm : safeCopy[gradeBand])
    .filter((l) => !l.startsWith('（'))
    .map((l) => l.replace(/（はい ?\/ ?いいえ）/g, '').trim());
  const primary = familyHarm
    ? resources.filter((r) => r.id === 'jidou_soudan' || r.id === 'emergency')
    : resources.filter((r) => r.id === 'sos_dial' || r.id === 'childline');

  useEffect(() => {
    document.documentElement.dataset['night'] = 'false';
  }, []);

  return (
    <main
      className="flex min-h-dvh flex-col items-center bg-calm-soft px-4 py-10 text-center"
      data-testid="safe-mode"
      data-adult-near={adultNear === null ? '' : String(adultNear)}
    >
      <PetAvatar characterId={characterId ?? 'moko'} expression="caring" size={140} />
      <div
        className="mt-6 max-w-md space-y-3 text-lg leading-relaxed"
        role="status"
        aria-live="assertive"
      >
        {message ? <p>{message}</p> : lines.map((l) => <p key={l}>{l}</p>)}
      </div>
      <div className="mt-8 flex w-full max-w-md flex-col gap-3">
        {primary.map((r) => (
          <a
            key={r.id}
            href={r.phone ? telHref(r.phone) : r.url}
            data-testid="safe-call"
            className="flex min-h-16 flex-col items-center justify-center rounded-card bg-leaf px-4 font-bold text-white shadow-soft hover:bg-leaf-deep focus-visible:outline-4 focus-visible:outline-calm-deep"
          >
            <span>📞 {r.name}</span>
            {r.phone && <span className="text-sm opacity-90">{r.phone}</span>}
          </a>
        ))}
      </div>
      {!familyHarm && adultNear === null && (
        <div className="mt-8 w-full max-w-md">
          <p className="font-display text-lg font-bold">{copy.adultNear}</p>
          <div className="mt-3 flex gap-3">
            <Button
              className="flex-1"
              variant="calm"
              data-testid="adult-yes"
              onClick={() => setAdultNear(true)}
            >
              {copy.yes}
            </Button>
            <Button
              className="flex-1"
              variant="secondary"
              data-testid="adult-no"
              onClick={() => setAdultNear(false)}
            >
              {copy.no}
            </Button>
          </div>
        </div>
      )}
      {adultNear === true && (
        <p className="mt-6 max-w-md leading-relaxed">
          {gradeBand === 'low'
            ? 'その おとなに、いま はなして みてね。'
            : 'その大人に、今話してみてね。'}
        </p>
      )}
      {adultNear === false && (
        <p className="mt-6 max-w-md leading-relaxed">
          {gradeBand === 'low'
            ? 'うえの ばんごうに でんわ してね。ここに いるよ。'
            : '上の番号に電話してね。ここにいるよ。'}
        </p>
      )}
      <div className="mt-auto pt-10">
        {!confirming ? (
          <Button variant="ghost" data-testid="safe-back" onClick={() => setConfirming(true)}>
            {copy.back}
          </Button>
        ) : (
          <div className="rounded-card bg-white p-4 shadow-soft">
            <p className="font-bold">{copy.confirmSafe}</p>
            <div className="mt-3 flex gap-3">
              <Button
                variant="primary"
                data-testid="safe-confirm-yes"
                onClick={() => router.push('/')}
              >
                {copy.confirmYes}
              </Button>
              <Button variant="secondary" onClick={() => setConfirming(false)}>
                {copy.confirmNo}
              </Button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
