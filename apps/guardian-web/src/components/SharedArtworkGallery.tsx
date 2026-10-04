'use client';

import type { SharedArtworksRes } from '@ijime/api-types';
import { ArrowLeft, ChevronRight, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiFailure, control, useGuardian } from './GuardianShell';
import { guardianRequest } from '@/lib/api';

export function SharedArtworkGallery({ childId }: { childId: string }) {
  const { me } = useGuardian();
  const [page, setPage] = useState<SharedArtworksRes | null>(null);
  const [cursor, setCursor] = useState<string | undefined>();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [failedImages, setFailedImages] = useState<Set<string>>(() => new Set());
  const requestId = useRef(0);
  const load = useCallback(
    async (token?: string) => {
      const run = ++requestId.current;
      setBusy(true);
      setPage(null);
      setError(null);
      setFailedImages(new Set());
      try {
        const query = new URLSearchParams({
          pageSize: '12',
          ...(token ? { pageToken: token } : {}),
        });
        const next = await guardianRequest<SharedArtworksRes>(
          `/v1/children/${encodeURIComponent(childId)}/shared-artworks?${query}`,
        );
        if (run !== requestId.current) return;
        setPage(next);
        setCursor(token);
      } catch (err) {
        if (run === requestId.current)
          setError(err instanceof Error ? err : new Error('request_failed'));
      } finally {
        if (run === requestId.current) setBusy(false);
      }
    },
    [childId],
  );
  useEffect(() => {
    void load();
    return () => {
      requestId.current++;
    };
  }, [load]);
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible') void load(cursor);
    };
    const hidden = () => {
      if (document.visibilityState !== 'visible') {
        requestId.current++;
        setPage(null);
      } else refresh();
    };
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, [load, cursor]);
  const child = me?.children.find((item) => item.childId === childId);
  return (
    <main className="mx-auto max-w-5xl px-4 py-6 sm:px-6" data-testid="shared-artwork-gallery">
      <Link href="/children" className="inline-flex min-h-11 items-center gap-2 text-sm underline">
        <ArrowLeft size={16} aria-hidden />
        お子さん一覧
      </Link>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-b border-ink/15 pb-4">
        <h2 className="min-w-0 break-words text-xl font-bold">
          {child ? `${child.nickname}さんが共有した絵` : '共有された絵'}
        </h2>
        <button
          className={control}
          disabled={busy}
          data-testid="shared-artwork-refresh"
          onClick={() => void load(cursor)}
        >
          <RefreshCw size={16} aria-hidden />
          更新
        </button>
      </div>
      <p
        className="mt-3 text-sm leading-relaxed text-ink/70"
        data-testid="shared-artwork-revocation-note"
      >
        共有を取り消した絵は、次回の更新で表示されなくなります。取得済みの画像は回収されません。発行済みリンクは最大5分間有効です。
      </p>
      {busy && (
        <p role="status" className="py-8 text-sm">
          読み込み中
        </p>
      )}
      {error && <ApiFailure error={error} retry={() => void load(cursor)} />}
      {page && !page.items.length && (
        <p className="py-10 text-sm" data-testid="shared-artwork-empty">
          表示できる絵はありません。
        </p>
      )}
      {page && (
        <div className="grid grid-cols-1 gap-x-6 gap-y-8 py-6 sm:grid-cols-2 lg:grid-cols-3">
          {page.items.map((item) => (
            <figure
              key={item.artworkId}
              className="min-w-0"
              data-testid="shared-artwork"
              data-artwork-id={item.artworkId}
            >
              {failedImages.has(item.artworkId) ? (
                <div
                  className="flex aspect-square items-center justify-center border border-ink/15 bg-white p-4 text-sm"
                  role="status"
                >
                  画像を読み込めませんでした。更新してください。
                </div>
              ) : (
                <img
                  src={item.imageUrl}
                  alt={item.type === 'story' ? '共有されたお話の絵' : '共有された自分の絵'}
                  className="aspect-square w-full rounded-md border border-ink/15 bg-white object-contain"
                  referrerPolicy="no-referrer"
                  onError={() =>
                    setFailedImages((previous) => new Set(previous).add(item.artworkId))
                  }
                />
              )}
              <figcaption className="mt-2 text-sm text-ink/70">
                {new Intl.DateTimeFormat('ja-JP', {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                  timeZone: 'Asia/Tokyo',
                }).format(new Date(item.sharedAt))}{' '}
                共有
              </figcaption>
            </figure>
          ))}
        </div>
      )}
      {page && (
        <nav className="flex flex-wrap gap-3 border-t border-ink/15 pt-4" aria-label="作品のページ">
          {cursor && (
            <button className={control} disabled={busy} onClick={() => void load()}>
              <ArrowLeft size={16} aria-hidden />
              最初のページ
            </button>
          )}
          {page.nextPageToken && (
            <button
              className={control}
              disabled={busy}
              data-testid="shared-artwork-next"
              onClick={() => void load(page.nextPageToken)}
            >
              次のページ
              <ChevronRight size={16} aria-hidden />
            </button>
          )}
        </nav>
      )}
    </main>
  );
}
