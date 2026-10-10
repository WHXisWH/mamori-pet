'use client';

import { useState } from 'react';

import { guardianRequest } from '@/lib/api';
import { control, field, useGuardian } from './GuardianShell';

export function GuardianDeletion() {
  const { me, childId, selectChild } = useGuardian();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState(false);

  if (!me || me.guardian.role !== 'primary' || me.children.length === 0) return null;
  const selected = childId || me.children[0]!.childId;
  async function requestDeletion() {
    if (!window.confirm('このお子さんのデータを削除します。あとから元に戻せません。続けますか？'))
      return;
    setBusy(true);
    setDone(false);
    setError(false);
    try {
      await guardianRequest(`/v1/children/${encodeURIComponent(selected)}/data-deletion-requests`, {
        method: 'POST',
        body: '{}',
      });
      setDone(true);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="border-t border-ink/10 py-6" data-testid="guardian-deletion">
      <h2 className="font-bold">お子さんのデータを削除</h2>
      <p className="mt-2 text-sm text-ink/70">
        会話、記録、通知を削除依頼します。削除後は元に戻せません。
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor="deletion-child">
          対象のお子さん
        </label>
        <select
          id="deletion-child"
          className={field}
          value={selected}
          onChange={(event) => selectChild(event.target.value)}
          disabled={busy}
        >
          {me.children.map((child) => (
            <option key={child.childId} value={child.childId}>
              {child.nickname || child.childId}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={control}
          disabled={busy}
          onClick={() => void requestDeletion()}
        >
          {busy ? '送信中' : '削除を依頼'}
        </button>
      </div>
      {done && (
        <p className="mt-3 text-sm text-emerald-800" role="status">
          削除依頼を受け付けました。
        </p>
      )}
      {error && (
        <p className="mt-3 text-sm text-alert" role="alert">
          依頼を送信できませんでした。もう一度お試しください。
        </p>
      )}
    </section>
  );
}
