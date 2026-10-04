'use client';

import type { CalendarConnectRes, CalendarSelectReq, CalendarsRes } from '@ijime/api-types';
import { CalendarDays, Link2, Unplug } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { GuardianApiError, guardianRequest } from '@/lib/api';
import { ApiFailure, control } from './GuardianShell';

export function CalendarConnection() {
  const [items, setItems] = useState<CalendarsRes['items'] | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [message, setMessage] = useState('');
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setUnavailable(false);
    try {
      const res = await guardianRequest<CalendarsRes>('/v1/calendar/calendars');
      setItems(res.items);
      setSelected(res.items.filter((item) => item.selected).map((item) => item.calendarId));
    } catch (err) {
      setItems(null);
      if (!(err instanceof GuardianApiError && err.code === 'NOT_FOUND')) {
        setUnavailable(true);
        if (!(err instanceof GuardianApiError && (err.status === 503 || err.status === 404)))
          setError(err instanceof Error ? err : new Error('request_failed'));
      }
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
    const result = new URLSearchParams(window.location.search).get('calendar');
    if (result && result !== 'connected') setMessage('カレンダーの連携は完了しませんでした。');
  }, [load]);
  async function connect() {
    setBusy(true);
    setError(null);
    setMessage('');
    try {
      const result = await guardianRequest<CalendarConnectRes>('/v1/calendar/connect', {
        method: 'POST',
        body: '{}',
      });
      const url = new URL(result.authUrl);
      if (url.protocol !== 'https:' || url.hostname !== 'accounts.google.com')
        throw new Error('invalid_authorization_url');
      window.location.assign(url.href);
    } catch (err) {
      setUnavailable(true);
      setError(err instanceof Error ? err : new Error('request_failed'));
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    setBusy(true);
    setError(null);
    setMessage('');
    const body: CalendarSelectReq = { calendarIds: selected };
    try {
      await guardianRequest<void>('/v1/calendar/connection', {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      setMessage('同期するカレンダーを保存しました。');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err : new Error('request_failed'));
    } finally {
      setBusy(false);
    }
  }
  async function disconnect() {
    setBusy(true);
    setError(null);
    setMessage('');
    try {
      await guardianRequest<void>('/v1/calendar/connection', { method: 'DELETE' });
      setItems(null);
      setSelected([]);
      setConfirmDisconnect(false);
      setUnavailable(false);
      setMessage('このアプリのカレンダー連携を解除しました。');
      window.dispatchEvent(new Event('guardian-context-refresh'));
    } catch (err) {
      setError(err instanceof Error ? err : new Error('request_failed'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="py-6" aria-labelledby="calendar-heading" data-testid="calendar-connection">
      <h2 id="calendar-heading" className="flex items-center gap-2 text-lg font-bold">
        <CalendarDays size={20} className="text-calm" aria-hidden />
        Google カレンダー
      </h2>
      {loading ? (
        <p className="py-5 text-sm" aria-busy="true">
          連携の状態を確認中
        </p>
      ) : items === null ? (
        <div className="mt-4 space-y-4">
          <p
            className="text-sm text-ink/70"
            data-testid={unavailable ? 'calendar-unavailable' : 'calendar-disconnected'}
          >
            {unavailable
              ? 'この環境では Google カレンダー連携を利用できません。連携は完了していません。'
              : 'Google カレンダーは連携されていません。'}
          </p>
          <button className={control} disabled={busy} onClick={() => void connect()}>
            <Link2 size={18} aria-hidden />
            {busy ? '確認中' : 'Google カレンダーを連携'}
          </button>
        </div>
      ) : (
        <div className="mt-4 space-y-4">
          <fieldset disabled={busy}>
            <legend className="mb-2 text-sm font-medium">同期するカレンダー</legend>
            {items.length === 0 && <p className="py-4 text-sm">選べるカレンダーはありません。</p>}
            <ul className="divide-y divide-ink/10">
              {items.map((item) => (
                <li key={item.calendarId}>
                  <label className="flex min-h-12 items-center gap-3 py-2 text-sm break-words">
                    <input
                      type="checkbox"
                      className="size-4 shrink-0 accent-emerald-700"
                      checked={selected.includes(item.calendarId)}
                      onChange={(e) =>
                        setSelected((ids) =>
                          e.target.checked
                            ? [...ids, item.calendarId]
                            : ids.filter((id) => id !== item.calendarId),
                        )
                      }
                    />
                    {item.name}
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
          <div className="flex flex-wrap gap-3">
            <button
              className={control}
              disabled={busy || !selected.length}
              onClick={() => void save()}
            >
              選択を保存
            </button>
            <button className={control} disabled={busy} onClick={() => setConfirmDisconnect(true)}>
              <Unplug size={17} aria-hidden />
              連携を解除
            </button>
          </div>
          {confirmDisconnect && (
            <div className="flex flex-wrap items-center gap-3 border-t border-ink/10 pt-4">
              <p className="text-sm">このアプリの連携を解除しますか？</p>
              <button
                className={`${control} !text-alert`}
                disabled={busy}
                onClick={() => void disconnect()}
              >
                解除する
              </button>
              <button
                className={control}
                disabled={busy}
                onClick={() => setConfirmDisconnect(false)}
              >
                やめる
              </button>
            </div>
          )}
        </div>
      )}
      {error && <ApiFailure error={error} retry={() => void load()} />}
      {message && (
        <p role="status" className="mt-4 text-sm" data-testid="calendar-result">
          {message}
        </p>
      )}
    </section>
  );
}
