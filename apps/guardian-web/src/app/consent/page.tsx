'use client';

import type { ConsentRes, ConsentsRes } from '@ijime/api-types';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import { guardianRequest, LOCAL_TEST } from '@/lib/api';
import { reauthenticateGuardian } from '@/lib/auth';

export default function ConsentPage() {
  const router = useRouter();
  const [terms, setTerms] = useState(false);
  const [sensitive, setSensitive] = useState(false);
  const [attested, setAttested] = useState(false);
  const [password, setPassword] = useState('');
  const [records, setRecords] = useState<ConsentsRes['items']>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState<string | null>(null);
  const [keys] = useState(() => ({
    guardian_terms: crypto.randomUUID(),
    guardian_sensitive: crypto.randomUUID(),
  }));
  const reload = async () => setRecords((await guardianRequest<ConsentsRes>('/v1/consents')).items);
  useEffect(() => {
    void reload().catch(() => setError('同意の記録を取得できません。先に登録を完了してください。'));
  }, []);
  const active = (type: string) =>
    records.some((r) => r.type === type && !r.revokedAt && !r.subjectChildId);
  const complete = active('guardian_terms') && active('guardian_sensitive');
  return (
    <main className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="text-2xl font-bold">利用と情報の取り扱いへの同意</h1>
      {LOCAL_TEST && (
        <p className="mt-3 border-l-4 border-amber-600 bg-amber-50 p-3 text-sm">
          ローカルの同意記録です。法的に有効な保護者確認が済んだことを意味しません。
        </p>
      )}
      <div className="mt-6 space-y-3 text-sm leading-7">
        <p>パートナーは AI です。医療やカウンセリング、緊急対応の代わりにはなりません。</p>
        <p>
          保護者に会話の原文やペットの記憶は表示しません。通常はお子さんと相談し、重大な危険があるときは安全のため大人に連絡します。家庭内の危険が疑われる場合は、家庭外の相談先を案内します。
        </p>
        <p>
          音声そのものは保存しません。文字にした会話などは暗号化します。お子さんは説明を確認し、データ源を選び、利用をやめたり削除を求めたりできます。
        </p>
      </div>
      <form
        className="mt-6 space-y-5"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError('');
          try {
            if (!LOCAL_TEST) {
              try {
                await reauthenticateGuardian(password);
              } catch {
                setError('パスワードを確認できませんでした。もう一度入力してください。');
                return;
              }
            }
            for (const type of ['guardian_terms', 'guardian_sensitive'] as const) {
              if (active(type)) continue;
              await guardianRequest<ConsentRes>('/v1/consents', {
                method: 'POST',
                headers: { 'Idempotency-Key': keys[type] },
                body: JSON.stringify({
                  type,
                  documentVersion: 'v0.1',
                  scope: { service: true },
                  verification: { guardianAttestation: 'legal_guardian_adult' },
                }),
              });
            }
            await reload();
            window.dispatchEvent(new Event('mamori-guardian-changed'));
            router.push('/children/new');
          } catch {
            setError('同意を完了できませんでした。時間をおいて、もう一度お試しください。');
            await reload().catch(() => {});
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="flex items-start gap-3 border-t border-gray-300 pt-5">
          <input
            type="checkbox"
            checked={terms || active('guardian_terms')}
            disabled={active('guardian_terms')}
            onChange={(e) => setTerms(e.target.checked)}
            className="mt-1 size-5 shrink-0"
          />
          <span>利用条件と「誰に何が伝わるか」を確認し、利用に同意します。</span>
        </label>
        <label className="flex items-start gap-3 border-t border-gray-300 pt-5">
          <input
            type="checkbox"
            checked={sensitive || active('guardian_sensitive')}
            disabled={active('guardian_sensitive')}
            onChange={(e) => setSensitive(e.target.checked)}
            className="mt-1 size-5 shrink-0"
          />
          <span>
            心の状態や困りごとなど、要配慮個人情報を支援と安全確認の目的で取り扱うことに、別途同意します。
          </span>
        </label>
        {!complete && (
          <>
            <label className="flex items-start gap-3 border-t border-gray-300 pt-5">
              <input
                type="checkbox"
                checked={attested}
                onChange={(e) => setAttested(e.target.checked)}
                className="mt-1 size-5 shrink-0"
              />
              <span>
                私は18歳以上で、利用するお子さんの親権者（法定代理人）であることを申告します。
              </span>
            </label>
            {!LOCAL_TEST && (
              <label className="block border-t border-gray-300 pt-5 text-sm font-medium">
                ご本人確認のため、ログイン用のパスワードをもう一度入力してください
                <input
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="mt-2 w-full rounded-md border border-gray-400 bg-white p-3"
                  autoComplete="current-password"
                />
              </label>
            )}
          </>
        )}
        {error && (
          <p role="alert" className="text-sm text-alert">
            {error}{' '}
            <Link href="/signup" className="underline">
              登録へ
            </Link>
          </p>
        )}
        <button
          disabled={
            busy ||
            (!complete && !attested) ||
            (!terms && !active('guardian_terms')) ||
            (!sensitive && !active('guardian_sensitive'))
          }
          className="min-h-11 rounded-md bg-calm px-5 py-3 text-white disabled:opacity-50"
        >
          {busy ? '保存中…' : '同意して子どもの登録へ'}
        </button>
      </form>
      {records.length > 0 && (
        <section className="mt-10 border-t border-gray-300 pt-6">
          <h2 className="text-lg font-semibold">同意の記録</h2>
          <ul className="mt-3 divide-y divide-gray-200">
            {records.map((record) => (
              <li
                key={record.consentId}
                className="flex flex-wrap items-center justify-between gap-3 py-4 text-sm"
              >
                <span>
                  {record.type === 'guardian_terms' ? '利用条件' : '要配慮個人情報'} ·{' '}
                  {record.documentVersion} ·{' '}
                  {new Date(record.grantedAt).toLocaleDateString('ja-JP')}
                  {record.revokedAt ? '（撤回済み）' : ''}
                </span>
                {!record.revokedAt && (
                  <button
                    className="min-h-11 text-alert underline"
                    disabled={busy}
                    onClick={() => setConfirm(record.consentId)}
                  >
                    撤回する
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      {confirm && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="withdraw-title"
          className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
        >
          <div className="w-full max-w-md rounded-lg bg-white p-6">
            <h2 id="withdraw-title" className="text-lg font-bold">
              同意を撤回しますか？
            </h2>
            <p className="mt-3 text-sm leading-6">
              お子さんの通常利用とデータ収集を停止します。すでに保存された情報は、この操作だけでは削除されません。
            </p>
            <div className="mt-5 flex flex-wrap justify-end gap-5">
              <button disabled={busy} onClick={() => setConfirm(null)}>
                戻る
              </button>
              <button
                disabled={busy}
                className="min-h-11 text-alert"
                onClick={async () => {
                  setBusy(true);
                  setError('');
                  try {
                    await guardianRequest(`/v1/consents/${confirm}`, { method: 'DELETE' });
                    await reload();
                    setTerms(false);
                    setSensitive(false);
                    setConfirm(null);
                    window.dispatchEvent(new Event('mamori-guardian-changed'));
                  } catch {
                    setError('撤回できませんでした。もう一度試してください。');
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                撤回して利用を停止
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
