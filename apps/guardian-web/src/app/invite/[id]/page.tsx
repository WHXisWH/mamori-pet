'use client';

import type { AcceptInviteRes } from '@ijime/api-types';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';

import { control } from '@/components/GuardianShell';
import { GuardianApiError, guardianRequest, LOCAL_TEST } from '@/lib/api';
import { guardianIdToken } from '@/lib/auth';

type Failure = { message: string; login: boolean };

function failureOf(err: unknown): Failure {
  if (err instanceof GuardianApiError) {
    if (err.code === 'UNAUTHENTICATED')
      return { message: 'ログインしてから招待を受けてください。', login: true };
    if (err.code === 'INVITATION_EXPIRED')
      return {
        message:
          '招待の期限が切れているか、すでに使われています。主保護者にもう一度招待してもらってください。',
        login: false,
      };
    if (err.code === 'PERMISSION_DENIED')
      return {
        message: `${err.message}。招待されたメールアドレスでログインし直してください。`,
        login: true,
      };
    if (err.code === 'NOT_FOUND')
      return { message: '招待が見つかりません。リンクを確認してください。', login: false };
    if (err.code === 'ALREADY_EXISTS') return { message: err.message, login: false };
  }
  return { message: '招待を受けられませんでした。もう一度お試しください。', login: false };
}

export default function AcceptInvitePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const loginHref = `/signup?invite=${encodeURIComponent(id)}`;

  async function accept() {
    setBusy(true);
    setFailure(null);
    try {
      await guardianRequest<AcceptInviteRes>(
        `/v1/guardians/invitations/${encodeURIComponent(id)}/accept`,
        { method: 'POST' },
      );
      if (!LOCAL_TEST) await guardianIdToken(true);
      window.dispatchEvent(new Event('mamori-guardian-changed'));
      router.push('/settings');
    } catch (err) {
      setFailure(failureOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-lg space-y-5 px-4 py-8" data-testid="invite-accept">
      <h1 className="text-2xl font-bold">保護者への招待</h1>
      <p className="text-sm leading-6">
        お子さんの見守りに、第二保護者として参加します。緊急のお知らせに一定時間応答がないとき、あなたにもお知らせが届きます。
      </p>
      <p className="text-sm leading-6 text-ink/70">
        招待されたメールアドレスでログインしてから進んでください。{' '}
        <Link href={loginHref} className="text-calm underline">
          ログイン・新規登録
        </Link>
      </p>
      {failure && (
        <div role="alert" className="text-sm text-alert" data-testid="invite-accept-error">
          <p>{failure.message}</p>
          {failure.login && (
            <Link href={loginHref} className="text-calm underline">
              ログイン画面へ
            </Link>
          )}
        </div>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={() => void accept()}
        className={`${control} !bg-emerald-700 !text-white`}
        data-testid="invite-accept-submit"
      >
        {busy ? '確認中' : '招待を受ける'}
      </button>
    </main>
  );
}
