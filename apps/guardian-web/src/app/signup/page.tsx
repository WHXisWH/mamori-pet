'use client';

import type { CreateFamilyRes } from '@ijime/api-types';
import {
  createUserWithEmailAndPassword,
  sendEmailVerification,
  signInWithEmailAndPassword,
} from 'firebase/auth';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { guardianRequest, LOCAL_TEST } from '@/lib/api';
import { guardianAuth, guardianIdToken } from '@/lib/auth';

export default function SignupPage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'signup' | 'login'>('signup');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  return (
    <main className="mx-auto max-w-lg px-4 py-8">
      <h1 className="text-2xl font-bold">保護者の登録</h1>
      {LOCAL_TEST && (
        <p role="status" className="mt-3 border-l-4 border-amber-600 bg-amber-50 p-3 text-sm">
          ローカル体験版です。本人確認・保護者資格の確認は行いません。実在するお子さんの情報を入力しないでください。
        </p>
      )}
      <form
        className="mt-6 space-y-5"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError('');
          try {
            let headers: Record<string, string> = {};
            if (LOCAL_TEST) {
              let id = localStorage.getItem('mamori-guardian-id');
              if (!id) {
                id = `g_${crypto.randomUUID()}`;
                localStorage.setItem('mamori-guardian-id', id);
              }
              headers = { 'X-Dev-Guardian-Id': id };
            } else {
              const auth = guardianAuth();
              if (!auth) throw new Error('not_configured');
              if (!sent) {
                const credentials =
                  mode === 'signup'
                    ? await createUserWithEmailAndPassword(auth, email, password)
                    : await signInWithEmailAndPassword(auth, email, password);
                if (!credentials.user.emailVerified) {
                  await sendEmailVerification(credentials.user);
                  setSent(true);
                  return;
                }
              }
              await auth.currentUser?.reload();
              if (!auth.currentUser?.emailVerified) {
                setError('メール内のリンクを確認してから、もう一度進んでください。');
                return;
              }
              headers = { Authorization: `Bearer ${await guardianIdToken(true)}` };
            }
            await guardianRequest<CreateFamilyRes>('/v1/families', {
              method: 'POST',
              headers,
              body: JSON.stringify({ ...(name.trim() ? { displayName: name.trim() } : {}) }),
            });
            if (!LOCAL_TEST) await guardianIdToken(true);
            window.dispatchEvent(new Event('mamori-guardian-changed'));
            router.push('/consent');
          } catch {
            setError(
              LOCAL_TEST
                ? '登録できませんでした。接続を確認して再試行してください。'
                : '登録できませんでした。認証設定とメールアドレスを確認してください。',
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="block text-sm font-medium">
          表示名（任意）
          <input
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-2 w-full rounded-md border border-gray-400 bg-white p-3"
            autoComplete="nickname"
          />
        </label>
        {!LOCAL_TEST && (
          <>
            <fieldset className="flex gap-4">
              <legend className="sr-only">アカウント</legend>
              {(['signup', 'login'] as const).map((value) => (
                <label key={value}>
                  <input
                    type="radio"
                    name="mode"
                    checked={mode === value}
                    onChange={() => {
                      setMode(value);
                      setSent(false);
                    }}
                  />{' '}
                  {value === 'signup' ? '新規登録' : 'ログイン'}
                </label>
              ))}
            </fieldset>
            <label className="block text-sm font-medium">
              メールアドレス
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                className="mt-2 w-full rounded-md border border-gray-400 bg-white p-3"
              />
            </label>
            <label className="block text-sm font-medium">
              パスワード
              <input
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                className="mt-2 w-full rounded-md border border-gray-400 bg-white p-3"
              />
            </label>
            {sent && (
              <p role="status">確認メールを送りました。リンクを開いてから続けてください。</p>
            )}
          </>
        )}
        {error && (
          <p role="alert" className="text-sm text-alert">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={busy}
          className="min-h-11 rounded-md bg-calm px-5 py-3 text-white disabled:opacity-50"
        >
          {busy
            ? '登録中…'
            : sent
              ? '確認して続ける'
              : LOCAL_TEST
                ? 'ローカル家族を登録'
                : '登録して続ける'}
        </button>
      </form>
    </main>
  );
}
