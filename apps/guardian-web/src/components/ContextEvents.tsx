'use client';

import type { ContextCategory, ContextEvent, CreateContextEventReq, Page } from '@ijime/api-types';
import { CalendarDays, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';

import { guardianRequest } from '@/lib/api';
import { ApiFailure, control, field, useGuardian } from './GuardianShell';

const categories: { value: ContextCategory; label: string }[] = [
  { value: 'exam', label: '試験' },
  { value: 'long_vacation', label: '長期休み' },
  { value: 'school_event', label: '学校行事' },
  { value: 'sick', label: '体調不良' },
  { value: 'travel', label: '旅行' },
  { value: 'class_change', label: 'クラスの変更' },
  { value: 'other', label: 'その他' },
];
const today = () => new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);

export function ContextEvents({ childId }: { childId: string }) {
  const { me } = useGuardian();
  const [items, setItems] = useState<ContextEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [adding, setAdding] = useState(false);
  const [category, setCategory] = useState<ContextCategory>('school_event');
  const [childIds, setChildIds] = useState([childId]);
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState(today);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<Error | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<Error | null>(null);
  const [message, setMessage] = useState('');
  useEffect(() => {
    const update = () => setRefresh((n) => n + 1);
    window.addEventListener('guardian-context-refresh', update);
    return () => window.removeEventListener('guardian-context-refresh', update);
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setError(null);
    void guardianRequest<Page<ContextEvent>>(
      `/v1/context-events?${new URLSearchParams({ childId })}`,
      { signal: abort.signal },
    )
      .then((res) => {
        if (!abort.signal.aborted) setItems(res.items);
      })
      .catch((err: unknown) => {
        if (!abort.signal.aborted) {
          setItems([]);
          setError(err instanceof Error ? err : new Error('request_failed'));
        }
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [childId, refresh]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || !childIds.length || startDate > endDate) return;
    setSaving(true);
    setSaveError(null);
    setMessage('');
    const body: CreateContextEventReq = { childIds, category, startDate, endDate };
    try {
      await guardianRequest<ContextEvent>('/v1/context-events', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setAdding(false);
      setMessage('予定・できごとを登録しました。');
      setRefresh((n) => n + 1);
    } catch (err) {
      setSaveError(err instanceof Error ? err : new Error('request_failed'));
    } finally {
      setSaving(false);
    }
  }
  async function remove(id: string) {
    setDeleting(id);
    setDeleteError(null);
    setMessage('');
    try {
      await guardianRequest<void>(`/v1/context-events/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      setItems((prev) => prev.filter((item) => item.eventId !== id));
      setConfirmDelete(null);
      setMessage('予定・できごとを削除しました。');
    } catch (err) {
      setDeleteError(err instanceof Error ? err : new Error('request_failed'));
    } finally {
      setDeleting(null);
    }
  }

  return (
    <section className="border-y border-ink/15 py-6" aria-labelledby="context-heading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="context-heading" className="text-lg font-bold">
          予定・できごとの記録
        </h2>
        <div className="flex gap-2">
          <button
            className={control}
            title="予定・できごとを更新"
            aria-label="予定・できごとを更新"
            disabled={loading}
            onClick={() => setRefresh((n) => n + 1)}
          >
            <RefreshCw size={18} aria-hidden />
          </button>
          <button
            className={control}
            onClick={() => {
              setAdding(true);
              setMessage('');
            }}
            disabled={adding}
          >
            <Plus size={18} aria-hidden />
            記録を追加
          </button>
        </div>
      </div>
      {adding && (
        <form
          className="mt-5 border-y border-ink/10 py-5"
          onSubmit={(event) => void save(event)}
          data-testid="context-form"
        >
          <div className="mb-4 flex items-center justify-between">
            <h3 className="font-bold">予定・できごとを追加</h3>
            <button
              type="button"
              className={control}
              title="入力を閉じる"
              aria-label="入力を閉じる"
              disabled={saving}
              onClick={() => setAdding(false)}
            >
              <X size={18} aria-hidden />
            </button>
          </div>
          <fieldset disabled={saving} className="space-y-5">
            <fieldset>
              <legend className="mb-2 text-sm font-medium">対象のお子さん</legend>
              <div className="flex flex-wrap gap-x-5 gap-y-3">
                {me?.children.map((child) => (
                  <label key={child.childId} className="flex min-h-11 items-center gap-2 text-sm">
                    <input
                      className="size-4 accent-emerald-700"
                      type="checkbox"
                      checked={childIds.includes(child.childId)}
                      onChange={(e) =>
                        setChildIds((ids) =>
                          e.target.checked
                            ? [...ids, child.childId]
                            : ids.filter((id) => id !== child.childId),
                        )
                      }
                    />
                    {child.nickname}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="grid gap-4 sm:grid-cols-3">
              <label className="min-w-0 text-sm font-medium">
                種類
                <select
                  className={`${field} mt-2`}
                  value={category}
                  onChange={(e) => setCategory(e.target.value as ContextCategory)}
                >
                  {categories.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="min-w-0 text-sm font-medium">
                開始日
                <input
                  className={`${field} mt-2`}
                  type="date"
                  value={startDate}
                  required
                  onChange={(e) => {
                    setStartDate(e.target.value);
                    if (e.target.value > endDate) setEndDate(e.target.value);
                  }}
                />
              </label>
              <label className="min-w-0 text-sm font-medium">
                終了日
                <input
                  className={`${field} mt-2`}
                  type="date"
                  value={endDate}
                  min={startDate}
                  required
                  onChange={(e) => setEndDate(e.target.value)}
                />
              </label>
            </div>
            {!childIds.length && (
              <p role="alert" className="text-sm text-alert">
                お子さんを選んでください。
              </p>
            )}
            {saveError && (
              <p role="alert" className="text-sm text-alert" data-testid="context-save-error">
                保存の完了を確認できませんでした。入力内容は残っています。
              </p>
            )}
            <button
              className={`${control} !bg-emerald-700 !text-white`}
              type="submit"
              disabled={!childIds.length || !startDate || !endDate || startDate > endDate}
            >
              {saving ? '保存中' : '登録する'}
            </button>
          </fieldset>
        </form>
      )}
      {message && (
        <p role="status" className="mt-4 text-sm text-emerald-800" data-testid="context-result">
          {message}
        </p>
      )}
      {deleteError && (
        <ApiFailure
          error={deleteError}
          retry={() => {
            if (confirmDelete) void remove(confirmDelete);
          }}
        />
      )}
      {loading ? (
        <p className="py-6 text-sm" aria-busy="true">
          記録を読み込み中
        </p>
      ) : error ? (
        <ApiFailure error={error} retry={() => setRefresh((n) => n + 1)} />
      ) : items.length === 0 ? (
        <p className="py-8 text-sm text-ink/65" data-testid="context-empty">
          このお子さんの予定・できごとはまだ登録されていません。
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-ink/10" data-testid="context-list">
          {items.map((item) => (
            <li
              key={item.eventId}
              className="flex flex-wrap items-center justify-between gap-3 py-4"
              data-testid="context-event"
              data-event-id={item.eventId}
            >
              <div className="min-w-0">
                <p className="flex items-center gap-2 text-sm font-bold">
                  <CalendarDays size={17} className="shrink-0 text-calm" aria-hidden />
                  {categories.find((c) => c.value === item.category)?.label ?? 'その他'}
                </p>
                <p className="mt-1 text-sm tabular-nums">
                  {item.startDate} ～ {item.endDate}
                </p>
                <p className="mt-1 text-xs text-ink/65">
                  {item.source === 'manual' ? '手動の記録' : 'Google カレンダー'} ·{' '}
                  {item.childIds
                    .map((id) => me?.children.find((child) => child.childId === id)?.nickname)
                    .filter(Boolean)
                    .join('、')}
                </p>
              </div>
              {item.source === 'manual' &&
                (confirmDelete === item.eventId ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm">削除しますか？</span>
                    <button
                      className={`${control} !text-alert`}
                      disabled={deleting !== null}
                      onClick={() => void remove(item.eventId)}
                    >
                      削除する
                    </button>
                    <button
                      className={control}
                      disabled={deleting !== null}
                      onClick={() => {
                        setConfirmDelete(null);
                        setDeleteError(null);
                      }}
                    >
                      やめる
                    </button>
                  </div>
                ) : (
                  <button
                    className={control}
                    title="この予定・できごとを削除"
                    aria-label="この予定・できごとを削除"
                    onClick={() => {
                      setConfirmDelete(item.eventId);
                      setDeleteError(null);
                    }}
                  >
                    <Trash2 size={17} aria-hidden />
                  </button>
                ))}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
