'use client';

import type { PairingCodeRes } from '@ijime/api-types';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import { guardianRequest, LOCAL_TEST } from '@/lib/api';

export default function PairingPage() {
  const { childId } = useParams<{ childId: string }>();
  const [pairing, setPairing] = useState<PairingCodeRes | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    if (!pairing) return;
    const update = () => setExpired(Date.now() >= Date.parse(pairing.expiresAt));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [pairing]);
  return (
    <main className="mx-auto max-w-lg px-4 py-8">
      <h1 className="text-2xl font-bold">子どもの端末をつなぐ</h1>
      <p className="mt-4 text-sm leading-7">
        お子さんと一緒に、子ども用アプリの「つなぐ」画面で番号を入力してください。番号は10分間・1回のみ有効です。新しく発行すると前の番号は使えなくなります。
      </p>
      {LOCAL_TEST && (
        <p className="mt-3 text-sm text-amber-800">
          ローカル体験版のペアリングです。本番の本人確認ではありません。
        </p>
      )}
      {pairing && (
        <section className="mt-6 border-y border-gray-300 py-6 text-center" aria-live="polite">
          <h2 className="text-sm text-gray-600">ペアリング番号</h2>
          <p
            data-testid="issued-pair-code"
            className="mt-3 font-mono text-4xl font-bold tabular-nums"
          >
            {pairing.code}
          </p>
          <p className="mt-3 text-sm">
            {expired
              ? '期限切れです。新しい番号を発行してください。'
              : `${new Date(pairing.expiresAt).toLocaleTimeString('ja-JP')} まで有効`}
          </p>
        </section>
      )}
      {error && (
        <p role="alert" className="mt-4 text-sm text-alert">
          {error}
        </p>
      )}
      <button
        className="mt-6 min-h-11 rounded-md bg-calm px-5 py-3 text-white disabled:opacity-50"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError('');
          try {
            setPairing(
              await guardianRequest<PairingCodeRes>(
                `/v1/children/${encodeURIComponent(childId)}/pairing-codes`,
                { method: 'POST', body: '{}' },
              ),
            );
          } catch {
            setError('番号を発行できませんでした。同意と接続を確認してください。');
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? '発行中…' : pairing ? '新しい番号を発行' : 'ペアリング番号を発行'}
      </button>
      <p className="mt-6 text-sm">
        <Link href="/" className="underline">
          ホームへ
        </Link>{' '}
        ·{' '}
        <Link href="/consent" className="underline">
          同意を確認
        </Link>
      </p>
    </main>
  );
}
