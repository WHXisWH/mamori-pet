'use client';

import Link from 'next/link';
import { ApiFailure, control, useGuardian } from '@/components/GuardianShell';

export default function ChildrenPage() {
  const { me, familyLoading, familyError, reloadFamily } = useGuardian();
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
        <p className="mt-6 text-sm">まだお子さんは登録されていません。</p>
      )}
      <ul className="mt-6 divide-y divide-gray-300">
        {me?.children.map((child) => (
          <li
            key={child.childId}
            className="flex flex-wrap items-center justify-between gap-4 py-5"
          >
            <div>
              <h2 className="text-lg font-semibold break-words">{child.nickname}</h2>
              <p className="mt-1 text-sm text-gray-600">
                {child.gradeBand === 'low'
                  ? '小学1〜3年生'
                  : child.gradeBand === 'high'
                    ? '小学4〜6年生'
                    : '中学生'}{' '}
                · {child.paired ? '接続済み' : '未接続'} ·{' '}
                {child.assentComplete ? '説明確認済み' : '子どもの説明確認待ち'}
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <Link href={`/children/${child.childId}/pairing`} className={control}>
                端末をつなぐ
              </Link>
              <Link href={`/children/${child.childId}/shared`} className={control}>
                共有された作品
              </Link>
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-8 text-sm">
        <Link href="/consent" className="text-calm underline">
          同意の記録・撤回
        </Link>
      </p>
    </main>
  );
}
