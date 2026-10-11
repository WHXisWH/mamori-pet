'use client';

import type { PairingCodeRes } from '@ijime/api-types';
import Link from 'next/link';
import { useEffect, useState } from 'react';

import { ApiFailure, control, useGuardian } from '@/components/GuardianShell';
import { loadPairing } from '@/lib/pairing-store';

const GRADE_LABEL = { low: '小学1〜3年生', high: '小学4〜6年生', jhs: '中学生' } as const;

export default function ChildrenPage() {
  const { me, familyLoading, familyError, reloadFamily } = useGuardian();
  const [codes, setCodes] = useState<Record<string, PairingCodeRes>>({});
  useEffect(() => {
    if (!me) return;
    const next: Record<string, PairingCodeRes> = {};
    for (const child of me.children) {
      const pairing = loadPairing(child.childId);
      if (pairing && !child.paired) next[child.childId] = pairing;
    }
    setCodes(next);
  }, [me]);
  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-bold">お子さん</h1>
        <Link href="/children/new" className={control}>
          子どもを登録
        </Link>
      </div>
      {familyLoading && (
        <p role="status" className="mt-6 text-sm">
          読み込み中…
        </p>
      )}
      {familyError && (
        <>
          <ApiFailure error={familyError} retry={() => void reloadFamily()} />
          <Link className="text-calm underline" href="/signup">
            保護者の登録へ
          </Link>
        </>
      )}
      {me && !me.family.consentComplete && (
        <p className="mt-6">
          <Link href="/consent" className="text-calm underline">
            保護者の同意を確認してください
          </Link>
        </p>
      )}
      {me && me.children.length === 0 && (
        <p className="mt-6 text-sm">
          まだお子さんは登録されていません。「子どもを登録」から始めてください。
        </p>
      )}
      <ul className="mt-6 divide-y divide-gray-300">
        {me?.children.map((child) => {
          const code = codes[child.childId];
          return (
            <li key={child.childId} className="py-5">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <h2 className="text-lg font-semibold break-words">{child.nickname}</h2>
                  <p className="mt-1 text-sm text-gray-600">
                    {GRADE_LABEL[child.gradeBand]} · {child.paired ? '接続済み' : '未接続'} ·{' '}
                    {child.assentComplete ? '説明確認済み' : '子どもの説明確認待ち'}
                  </p>
                </div>
                <div className="flex flex-wrap gap-3">
                  <Link
                    href={`/children/${child.childId}/pairing`}
                    className={child.paired ? control : `${control} bg-calm text-white`}
                  >
                    {child.paired ? '端末をつなぎ直す' : '端末をつなぐ'}
                  </Link>
                  <Link href={`/children/${child.childId}/shared`} className={control}>
                    共有された作品
                  </Link>
                </div>
              </div>
              {!child.paired && (
                <p className="mt-3 rounded-md bg-emerald-50 px-3 py-2 text-sm leading-6">
                  <span className="font-bold">次にすること：</span>
                  「端末をつなぐ」で番号を発行し、お子さんの端末の子ども用アプリで入力します。
                  {code && (
                    <>
                      {' '}
                      いま有効な番号：
                      <span
                        className="font-mono font-bold tabular-nums"
                        data-testid="active-pair-code"
                      >
                        {code.code}
                      </span>
                      （{new Date(code.expiresAt).toLocaleTimeString('ja-JP')} まで）
                    </>
                  )}
                </p>
              )}
              {child.paired && !child.assentComplete && (
                <p className="mt-3 text-sm leading-6 text-ink/70">
                  端末はつながっています。お子さんがアプリの説明を読んで「わかった」と答えると完了です。
                </p>
              )}
            </li>
          );
        })}
      </ul>
      <p className="mt-8 text-sm">
        <Link href="/consent" className="text-calm underline">
          同意の記録・撤回
        </Link>{' '}
        ·{' '}
        <Link href="/guides" className="text-calm underline">
          使い方
        </Link>
      </p>
    </main>
  );
}
