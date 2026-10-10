'use client';

import type {
  NotificationDetail,
  NotificationFeedbackReq,
  NotificationFeedbackRes,
} from '@ijime/api-types';
import { Save } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { guardianRequest } from '@/lib/api';
import { control } from './GuardianShell';

const actions: { value: NotificationFeedbackReq['action']; label: string }[] = [
  { value: 'talked', label: 'お子さんと話しました' },
  { value: 'planned', label: 'これから話す予定です' },
  { value: 'need_help', label: '対応について相談したいです' },
];

export function NotificationFeedback({ notice }: { notice: NotificationDetail }) {
  const [feedback, setFeedback] = useState(notice.feedback);
  const [selected, setSelected] = useState<NotificationFeedbackReq['action'] | ''>(
    notice.feedback?.action ?? '',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [saved, setSaved] = useState(false);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || busy) return;
    setBusy(true);
    setError(false);
    setSaved(false);
    try {
      const result = await guardianRequest<NotificationFeedbackRes>(
        `/v1/notifications/${encodeURIComponent(notice.id)}/feedback`,
        { method: 'PUT', body: JSON.stringify({ action: selected }) },
      );
      setFeedback(result.feedback);
      setSelected(result.feedback.action);
      setSaved(true);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  const suggestions = notice.suggestions.try.filter((text) => text.trim());
  return (
    <section className="space-y-3 border-t border-ink/15 pt-6" data-testid="notification-feedback">
      <h3 className="font-bold">その後の対応</h3>
      <p className="text-sm text-ink/70">
        通知の確認とは別に、保護者の対応を記録します。問題が解決したという記録ではありません。
      </p>
      {feedback && (
        <p className="text-sm" data-testid="notification-feedback-current">
          <span>記録済み：{actions.find((action) => action.value === feedback.action)?.label}</span>
          <time className="mt-1 block text-ink/70" dateTime={feedback.updatedAt}>
            {new Date(feedback.updatedAt).toLocaleString('ja-JP')}
          </time>
        </p>
      )}
      <form onSubmit={(event) => void save(event)} className="space-y-3">
        <fieldset disabled={busy}>
          <legend className="sr-only">保護者の対応</legend>
          {actions.map(({ value, label }) => (
            <label key={value} className="flex min-h-12 items-center gap-3 py-2 text-sm">
              <input
                type="radio"
                name={`notification-feedback-${notice.id}`}
                value={value}
                data-testid={`feedback-action-${value.replace('_', '-')}`}
                checked={selected === value}
                className="size-4 shrink-0 accent-emerald-700"
                onChange={() => {
                  setSelected(value);
                  setSaved(false);
                  setError(false);
                }}
              />
              <span>{label}</span>
            </label>
          ))}
        </fieldset>
        {selected === 'need_help' && (
          <div className="space-y-2 text-sm" data-testid="notification-feedback-help">
            <p>一人で抱えず、相談先と一緒に対応を考えられます。</p>
            {suggestions.length > 0 && (
              <ul className="list-inside list-disc space-y-2">
                {suggestions.map((text, index) => (
                  <li key={index} className="break-words">
                    {text}
                  </li>
                ))}
              </ul>
            )}
            {notice.resources.length > 0 && (
              <a
                href="#notification-resources"
                className="inline-flex min-h-11 items-center text-calm underline"
              >
                相談先を見る
              </a>
            )}
            <p className="text-ink/70">この記録だけでは、相談先への連絡は行われません。</p>
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-alert">
            保存の完了を確認できませんでした。もう一度保存してください。
          </p>
        )}
        <button
          type="submit"
          className={control}
          disabled={busy || !selected}
          data-testid="notification-feedback-save"
        >
          <Save size={17} aria-hidden />
          <span>{busy ? '保存中' : '対応を保存'}</span>
        </button>
      </form>
      {saved && (
        <p
          role="status"
          className="text-sm text-emerald-800"
          data-testid="notification-feedback-saved"
        >
          対応を記録しました。問題の解決や、お子さんの安心を確認したものではありません。
        </p>
      )}
    </section>
  );
}
