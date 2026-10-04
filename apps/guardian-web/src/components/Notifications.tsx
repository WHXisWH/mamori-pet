'use client';

import type { AckRes, NotificationDetail } from '@ijime/api-types';
import { RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { guardianRequest } from '@/lib/api';
import { useGuardian } from './GuardianShell';

export { GuardianHeader } from './GuardianShell';

const button = 'rounded-lg border border-ink/20 px-4 py-3 font-medium disabled:opacity-50';

function Failure({ retry }: { retry: () => void }) {
  return (
    <div role="alert" className="my-4 space-y-3">
      <p>接続できませんでした。まだ操作は完了していません。</p>
      <button className={button} onClick={retry}>
        再試行
      </button>
    </div>
  );
}

export function NotificationList({ childId = '' }: { childId?: string }) {
  const {
    notifications: items,
    noticesError: error,
    noticesLoading: loading,
    reloadNotices: load,
  } = useGuardian();
  const [filter, setFilter] = useState<'all' | 'unacknowledged'>('unacknowledged');
  const shown = items.filter(
    (item) => (!childId || item.childId === childId) && (filter === 'all' || !item.acknowledgedAt),
  );
  return (
    <>
      <section className="py-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-bold">お知らせ</h2>
          <button
            className={`${button} inline-flex items-center gap-2`}
            disabled={loading}
            onClick={() => void load()}
          >
            <RefreshCw size={16} aria-hidden />
            更新
          </button>
        </div>
        <div className="my-4 flex gap-2" role="group" aria-label="表示する通知">
          <button
            className={button}
            aria-pressed={filter === 'unacknowledged'}
            onClick={() => setFilter('unacknowledged')}
          >
            未確認
          </button>
          <button
            className={button}
            aria-pressed={filter === 'all'}
            onClick={() => setFilter('all')}
          >
            すべて
          </button>
        </div>
        {error ? (
          <Failure retry={() => void load()} />
        ) : loading && items.length === 0 ? (
          <p aria-busy="true">読み込み中</p>
        ) : (
          <>
            {shown.length === 0 && (
              <p data-testid="notifications-empty" className="py-6 text-ink/70">
                お知らせはありません。
              </p>
            )}
            <ul className="divide-y divide-ink/10" data-testid="notifications-list">
              {shown.map((item) => (
                <li key={item.id}>
                  <Link
                    href={`/notifications/${encodeURIComponent(item.id)}`}
                    className="block py-5"
                    data-testid="notification-link"
                  >
                    <span className="block font-bold break-words">{item.title}</span>
                    <span className="mt-2 block text-sm text-ink/70">
                      {new Date(item.createdAt).toLocaleString('ja-JP')} ·{' '}
                      {item.acknowledgedAt ? '確認済み' : '未確認'}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </>
  );
}

export function NotificationView({ id }: { id: string }) {
  const { reloadNotices, acknowledgeNotice } = useGuardian();
  const [notice, setNotice] = useState<NotificationDetail | null>(null);
  const [error, setError] = useState(false);
  const [ackError, setAckError] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setError(false);
    setNotice(null);
    try {
      setNotice(
        await guardianRequest<NotificationDetail>(`/v1/notifications/${encodeURIComponent(id)}`),
      );
    } catch {
      setError(true);
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);
  async function acknowledge() {
    setBusy(true);
    setAckError(false);
    try {
      const res = await guardianRequest<AckRes>(`/v1/notifications/${encodeURIComponent(id)}/ack`, {
        method: 'POST',
        body: '{}',
      });
      setNotice((n) => (n ? { ...n, acknowledgedAt: res.acknowledgedAt } : null));
      acknowledgeNotice(id, res.acknowledgedAt);
      await reloadNotices();
    } catch {
      setAckError(true);
    } finally {
      setBusy(false);
    }
  }
  if (error) return <Failure retry={() => void load()} />;
  if (!notice)
    return (
      <p className="py-6" aria-busy="true">
        読み込み中
      </p>
    );
  const changes = notice.changes.filter((text) => text.trim());
  const suggestions = notice.suggestions.try.filter((text) => text.trim());
  const avoid = notice.suggestions.avoid.filter((text) => text.trim());
  return (
    <article className="space-y-6 py-6" data-testid="notification-detail">
      {notice.kind === 'crisis' && !notice.acknowledgedAt && (
        <p role="alert" className="rounded-lg border border-alert p-4 font-bold text-alert">
          安全に関するお知らせです。今すぐ内容をご確認ください。
        </p>
      )}
      <h2 className="text-xl font-bold break-words">{notice.title}</h2>
      {changes.length > 0 && (
        <section>
          <h3 className="mb-2 font-bold">最近の変化</h3>
          <ul className="list-inside list-disc space-y-2">
            {changes.map((text, i) => (
              <li key={i}>{text}</li>
            ))}
          </ul>
        </section>
      )}
      {notice.meaning.trim() && (
        <section>
          <h3 className="mb-2 font-bold">考えられること</h3>
          <p className="break-words">{notice.meaning}</p>
        </section>
      )}
      {notice.childSummary?.trim() && (
        <section data-testid="child-approved-summary">
          <h3 className="mb-2 font-bold">お子さんが共有を選んだ言葉</h3>
          <p className="break-words whitespace-pre-wrap">{notice.childSummary}</p>
        </section>
      )}
      {suggestions.length > 0 && (
        <section>
          <h3 className="mb-2 font-bold">できること</h3>
          <ul className="list-inside list-disc space-y-2">
            {suggestions.map((text, i) => (
              <li key={i}>{text}</li>
            ))}
          </ul>
        </section>
      )}
      {avoid.length > 0 && (
        <section>
          <h3 className="mb-2 font-bold">避けたいこと</h3>
          <ul className="list-inside list-disc space-y-2">
            {avoid.map((text, i) => (
              <li key={i}>{text}</li>
            ))}
          </ul>
        </section>
      )}
      {notice.resources.length > 0 && (
        <section>
          <h3 className="mb-2 font-bold">相談先</h3>
          <ul className="space-y-3">
            {notice.resources.map((r) => (
              <li key={r.id}>
                <p>{r.name}</p>
                {r.phone && (
                  <a
                    className="text-calm underline"
                    href={`tel:${r.phone.replace(/[^+0-9]/g, '')}`}
                  >
                    {r.phone}
                  </a>
                )}
                {r.url && (
                  <a
                    className="ml-3 text-calm underline"
                    href={r.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    相談先のページ
                  </a>
                )}
                {r.hours && <p className="text-sm text-ink/70">{r.hours}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}
      {ackError && <Failure retry={() => void acknowledge()} />}
      {notice.acknowledgedAt ? (
        <p role="status" data-testid="notification-acknowledged">
          確認済み。これは問題の解決を意味しません。
        </p>
      ) : (
        <button
          className={`${button} bg-calm text-white`}
          data-testid="notification-ack"
          disabled={busy}
          onClick={() => void acknowledge()}
        >
          内容を確認しました
        </button>
      )}
    </article>
  );
}
