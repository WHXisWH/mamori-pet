'use client';

import Link from 'next/link';

import { useGuardian } from './GuardianShell';

/** 設定が終わるまでホームに出す案内。未接続の子がいなくなったら消える。 */
export function GettingStarted() {
  const { me } = useGuardian();
  if (!me?.family.consentComplete) return null;
  const pending = me.children.filter((c) => !c.paired || !c.assentComplete);
  if (me.children.length > 0 && pending.length === 0) return null;
  return (
    <section
      className="mt-2 rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm leading-7"
      data-testid="getting-started"
    >
      <h2 className="font-bold">はじめての設定</h2>
      <ol className="mt-1 list-decimal pl-5">
        <li>
          {me.children.length === 0 ? (
            <Link href="/children/new" className="text-calm underline">
              子どもを登録する
            </Link>
          ) : (
            '子どもを登録する（済み）'
          )}
        </li>
        <li>
          {pending.some((c) => !c.paired) ? (
            <Link
              href={`/children/${pending.find((c) => !c.paired)!.childId}/pairing`}
              className="text-calm underline"
            >
              お子さんの端末をつなぐ（番号を発行して、子ども用アプリで入力）
            </Link>
          ) : (
            'お子さんの端末をつなぐ（済み）'
          )}
        </li>
        <li>お子さんがアプリの説明を読んで「わかった」と答える</li>
      </ol>
      <p className="mt-2">
        <Link href="/guides" className="text-calm underline">
          くわしい使い方
        </Link>
      </p>
    </section>
  );
}
