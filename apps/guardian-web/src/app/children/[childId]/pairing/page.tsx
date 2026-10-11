'use client';

import type { PairingCodeRes } from '@ijime/api-types';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

import { SetupSteps } from '@/components/SetupSteps';
import { CHILD_APP_URL, guardianRequest, LOCAL_TEST } from '@/lib/api';
import { loadPairing, savePairing } from '@/lib/pairing-store';

const PAIR_URL = `${CHILD_APP_URL}/pair`;

export default function PairingPage() {
  const { childId } = useParams<{ childId: string }>();
  const [pairing, setPairing] = useState<PairingCodeRes | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [expired, setExpired] = useState(false);
  const [qr, setQr] = useState('');
  // ホームへ行って戻って来ても、期限内なら同じ番号を見せる
  useEffect(() => {
    setPairing(loadPairing(childId) ?? null);
  }, [childId]);
  useEffect(() => {
    QRCode.toDataURL(PAIR_URL, { margin: 1, width: 176 })
      .then(setQr)
      .catch(() => setQr(''));
  }, []);
  useEffect(() => {
    if (!pairing) return;
    const update = () => setExpired(Date.now() >= Date.parse(pairing.expiresAt));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [pairing]);
  const issue = async () => {
    setBusy(true);
    setError('');
    try {
      const issued = await guardianRequest<PairingCodeRes>(
        `/v1/children/${encodeURIComponent(childId)}/pairing-codes`,
        { method: 'POST', body: '{}' },
      );
      savePairing(childId, issued);
      setPairing(issued);
    } catch {
      setError('番号を発行できませんでした。同意と接続を確認してください。');
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="mx-auto max-w-lg px-4 py-8">
      <SetupSteps current="pair" />
      <h1 className="mt-6 text-2xl font-bold">子どもの端末をつなぐ</h1>
      <ol className="mt-4 list-decimal space-y-2 pl-5 text-sm leading-7">
        <li>下のボタンでペアリング番号を発行します（10分間・1回のみ有効）。</li>
        <li>
          お子さんの端末で子ども用アプリを開きます：{' '}
          <a href={PAIR_URL} className="font-mono break-all text-calm underline">
            {PAIR_URL}
          </a>
          （下の QR コードを読み取っても開けます）
        </li>
        <li>「つなぐ」画面に番号を入力すると、お子さんの端末がこの家族につながります。</li>
      </ol>
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
          {!expired && (
            <p className="mt-2 text-xs text-ink/65">
              この番号はこの端末に残ります。別のページを見てからここに戻っても、期限内なら同じ番号です。
            </p>
          )}
        </section>
      )}
      <div className="mt-6 flex flex-wrap items-center gap-6">
        {qr && (
          <img
            src={qr}
            width={176}
            height={176}
            alt={`子ども用アプリ ${PAIR_URL} を開く QR コード`}
            className="rounded-md border border-ink/15 bg-white p-1"
            data-testid="child-app-qr"
          />
        )}
        <div className="text-sm leading-7">
          <p className="font-semibold">お子さんの端末で開くアドレス</p>
          <a href={PAIR_URL} className="font-mono break-all text-calm underline">
            {PAIR_URL}
          </a>
          <p className="mt-1 text-ink/65">iPhone・Android・PC のブラウザで開けます。</p>
        </div>
      </div>
      {error && (
        <p role="alert" className="mt-4 text-sm text-alert">
          {error}
        </p>
      )}
      <button
        className="mt-6 min-h-11 rounded-md bg-calm px-5 py-3 text-white disabled:opacity-50"
        disabled={busy}
        onClick={() => void issue()}
      >
        {busy ? '発行中…' : pairing ? '新しい番号を発行' : 'ペアリング番号を発行'}
      </button>
      {pairing && !expired && (
        <section className="mt-8 rounded-md bg-emerald-50 p-4 text-sm leading-7">
          <h2 className="font-bold">次にすること</h2>
          <p>
            お子さんの端末で番号を入れたあと、お子さんがアプリの説明を読んで「わかった」と答えると設定は完了です。「お子さん」のページで「接続済み」「説明確認済み」に変わります。
          </p>
        </section>
      )}
      <p className="mt-6 text-sm">
        <Link href="/children" className="underline">
          お子さん一覧へ
        </Link>{' '}
        ·{' '}
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
