'use client';

import type { CreateChildRes, GradeBand } from '@ijime/api-types';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import Link from 'next/link';

import { GuardianApiError, guardianRequest } from '@/lib/api';
import { useGuardian } from '@/components/GuardianShell';
import { SetupSteps } from '@/components/SetupSteps';

export default function NewChildPage() {
  const router = useRouter();
  const { me, reloadFamily, selectChild } = useGuardian();
  const [nickname, setNickname] = useState('');
  const [gradeBand, setGradeBand] = useState<GradeBand>('high');
  const [key] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const duplicate = me?.children.find((c) => c.nickname === nickname.trim());
  return (
    <main className="mx-auto max-w-lg px-4 py-8">
      <SetupSteps current="register" />
      <h1 className="mt-6 text-2xl font-bold">子どもを登録</h1>
      {duplicate && (
        <p
          className="mt-4 rounded-md bg-amber-50 px-3 py-2 text-sm leading-6"
          data-testid="duplicate-child"
        >
          同じニックネームのお子さん「{duplicate.nickname}」がすでに登録されています（
          {duplicate.paired ? '接続済み' : '未接続'}）。同じ子なら新しく登録せず、
          <Link href={`/children/${duplicate.childId}/pairing`} className="text-calm underline">
            端末をつなぐ
          </Link>
          へ進んでください。
        </p>
      )}
      <form
        className="mt-6 space-y-5"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError('');
          try {
            const { childId } = await guardianRequest<CreateChildRes>('/v1/children', {
              method: 'POST',
              headers: { 'Idempotency-Key': key },
              body: JSON.stringify({ nickname: nickname.trim(), gradeBand }),
            });
            await reloadFamily();
            selectChild(childId);
            router.push(`/children/${childId}/pairing`);
          } catch (err) {
            if (err instanceof GuardianApiError && err.code === 'CONSENT_REQUIRED')
              router.push('/consent');
            else setError('登録できませんでした。入力と接続を確認してください。');
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="block text-sm font-medium">
          ニックネーム
          <input
            required
            minLength={1}
            maxLength={20}
            autoComplete="off"
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            className="mt-2 w-full rounded-md border border-gray-400 bg-white p-3"
          />
          <span className="mt-2 block text-sm font-normal text-gray-600">
            本名・学校名・住所は入力しないでください。
          </span>
        </label>
        <label className="block text-sm font-medium">
          学年
          <select
            value={gradeBand}
            onChange={(e) => setGradeBand(e.target.value as GradeBand)}
            className="mt-2 w-full rounded-md border border-gray-400 bg-white p-3"
          >
            <option value="low">小学1〜3年生</option>
            <option value="high">小学4〜6年生</option>
            <option value="jhs">中学生</option>
          </select>
        </label>
        {error && (
          <p role="alert" className="text-sm text-alert">
            {error}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-5">
          <button
            disabled={busy || !nickname.trim()}
            className="min-h-11 rounded-md bg-calm px-5 py-3 text-white disabled:opacity-50"
          >
            {busy ? '登録中…' : '登録してペアリングへ'}
          </button>
          <Link className="text-sm underline" href="/consent">
            同意を確認
          </Link>
        </div>
      </form>
    </main>
  );
}
