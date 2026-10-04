'use client';

import type { HelpResource, HelpResourcesRes } from '@ijime/api-types';
import { useEffect, useState } from 'react';

import { fetchHelpResources } from '@/lib/api';

function telHref(phone: string): string {
  return `tel:${phone.split('/')[0]!.replace(/[^\d+]/g, '')}`;
}

function ResourceCard({ r }: { r: HelpResource }) {
  return (
    <li className="rounded-2xl bg-white p-4 shadow-sm">
      <h2 className="text-lg font-bold">{r.name}</h2>
      <p className="text-sm text-ink/70">{r.audience}</p>
      {r.hours && <p className="text-sm text-ink/70">{r.hours}</p>}
      {r.phone && (
        <a
          href={telHref(r.phone)}
          data-testid="hotline-call"
          className="mt-3 flex min-h-14 items-center justify-center rounded-xl bg-leaf text-lg font-bold text-white hover:brightness-95 focus-visible:outline-4 focus-visible:outline-calm-deep"
        >
          📞 {r.phone} に でんわする
        </a>
      )}
      {r.url && (
        <a href={r.url} className="mt-2 block text-sm underline" rel="noreferrer">
          くわしく みる
        </a>
      )}
    </li>
  );
}

export function HelpResources({ initial }: { initial: HelpResourcesRes }) {
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
        相談できるところ
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
      <p className="mt-8 text-xs text-ink/60">番号と受付時間は公開前に確認します。</p>
    </section>
  );
}
