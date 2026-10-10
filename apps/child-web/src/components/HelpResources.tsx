'use client';

import type { HelpResource, HelpResourcesRes } from '@ijime/api-types';
import { Phone } from 'lucide-react';
import { useEffect, useState } from 'react';

import { fetchHelpResources } from '@/lib/api';
import { useChildStore } from '@/lib/store';
import { FuriganaText } from './FuriganaText';
import { ReadAloudButton } from './requests/ReadAloudButton';

function telHref(phone: string): string {
  return `tel:${phone.replace(/[^\d+]/g, '')}`;
}

function ResourceCard({ r }: { r: HelpResource }) {
  const low = useChildStore((s) => s.gradeBand === 'low');
  return (
    <li className="rounded-2xl bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <h2 className="text-lg font-bold">
          <FuriganaText text={r.name} enabled={low} />
        </h2>
        <ReadAloudButton
          text={[r.name, r.audience, r.hours, r.phone].filter(Boolean).join('。')}
          className="shrink-0"
        />
      </div>
      <p className="text-sm text-ink/70">
        <FuriganaText text={r.audience} enabled={low} />
      </p>
      {r.hours && (
        <p className="text-sm text-ink/70">
          <FuriganaText text={r.hours} enabled={low} />
        </p>
      )}
      {r.phone?.split('/').map((phone) => (
        <a
          key={phone}
          href={telHref(phone)}
          data-testid="hotline-call"
          className="mt-3 flex min-h-14 flex-col items-center justify-center gap-1 rounded-xl bg-leaf px-3 py-2 text-lg font-bold text-white hover:brightness-95 focus-visible:outline-4 focus-visible:outline-calm-deep"
        >
          <span className="flex items-center gap-2 whitespace-nowrap">
            <Phone aria-hidden="true" className="size-5 shrink-0" />
            {phone.trim()}
          </span>
          <span className="text-sm">に でんわする</span>
        </a>
      ))}
      {r.url && (
        <a href={r.url} className="mt-2 block text-sm underline" rel="noreferrer">
          くわしく みる
        </a>
      )}
    </li>
  );
}

export function HelpResources({ initial }: { initial: HelpResourcesRes }) {
  const low = useChildStore((s) => s.gradeBand === 'low');
  const [data, setData] = useState(initial);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const update = () => setOffline(!navigator.onLine);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    fetchHelpResources(controller.signal)
      .then((fresh) => {
        setData(fresh);
        setOffline(!navigator.onLine);
      })
      .catch(() => setOffline(true));
    return () => {
      controller.abort();
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  return (
    <section aria-labelledby="help-title" className="mx-auto max-w-md px-4 py-8">
      <h1 id="help-title" className="text-2xl font-bold">
        <FuriganaText text="相談できるところ" enabled={low} />
      </h1>
      <p className="mt-2 text-ink/80">ひとりで かかえなくて いいよ。ここに でんわ できるよ。</p>
      {offline && (
        <p
          role="status"
          data-testid="offline-notice"
          className="mt-3 rounded-xl bg-calm/15 p-3 text-sm"
        >
          いまは ネットに つながっていません。でんわは できるよ。
        </p>
      )}
      <ul className="mt-6 space-y-4" data-testid="hotline-list" data-version={data.version}>
        {data.resources.map((r) => (
          <ResourceCard key={r.id} r={r} />
        ))}
      </ul>
      <p className="mt-8 text-xs text-ink/60">
        {low
          ? 'でんわばんごうと うけつけじかんは、こうかいまえに かくにんします。'
          : '番号と受付時間は公開前に確認します。'}
      </p>
    </section>
  );
}
