'use client';

import type { NotifyChannel, NotifySettingsReq } from '@ijime/api-types';
import { Bell, Mail, Save, Smartphone } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';

import { guardianRequest } from '@/lib/api';
import { ApiFailure, control, field, useGuardian } from './GuardianShell';
import { PushRegistration } from './PushRegistration';

const channels: { id: NotifyChannel; label: string; Icon: typeof Bell }[] = [
  { id: 'webpush', label: 'ブラウザ通知', Icon: Bell },
  { id: 'email', label: 'メール', Icon: Mail },
  { id: 'sms', label: 'SMS（緊急連絡）', Icon: Smartphone },
];
export function NotificationSettings() {
  const { me } = useGuardian();
  const [selected, setSelected] = useState<NotifyChannel[]>([]);
  const [phone, setPhone] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [saveError, setSaveError] = useState<Error | null>(null);
  const [saved, setSaved] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const value = await guardianRequest<NotifySettingsReq>('/v1/guardians/me/notify-settings');
      setSelected(value.channels);
      setPhone(value.phoneE164 ?? '');
    } catch (err) {
      setLoadError(err instanceof Error ? err : new Error('request_failed'));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setSaveError(null);
    setSaved(false);
    const body: NotifySettingsReq = {
      channels: selected,
      ...(phone.trim() ? { phoneE164: phone.trim() } : {}),
    };
    try {
      await guardianRequest<void>('/v1/guardians/me/notify-settings', {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      setSaved(true);
    } catch (err) {
      setSaveError(err instanceof Error ? err : new Error('request_failed'));
    } finally {
      setBusy(false);
    }
  }
  if (loading)
    return (
      <p className="py-8" aria-busy="true">
        通知設定を読み込み中
      </p>
    );
  if (loadError) return <ApiFailure error={loadError} retry={() => void load()} />;
  return (
    <form
      onSubmit={(event) => void save(event)}
      className="max-w-2xl space-y-6 py-6"
      data-testid="notification-settings"
    >
      <h2 className="text-lg font-bold">通知・連絡先</h2>
      <fieldset disabled={busy} className="space-y-6">
        <fieldset>
          <legend className="mb-2 text-sm font-bold">通常のお知らせ</legend>
          <div className="divide-y divide-ink/10">
            {channels.map(({ id, label, Icon }) => (
              <label key={id} className="flex min-h-14 items-center gap-3 py-3 text-sm">
                <input
                  type="checkbox"
                  className="size-4 accent-emerald-700"
                  checked={selected.includes(id)}
                  onChange={(e) => {
                    setSaved(false);
                    setSelected((value) =>
                      e.target.checked ? [...value, id] : value.filter((item) => item !== id),
                    );
                  }}
                />
                <Icon size={18} aria-hidden />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
        <p className="text-sm text-ink/70">メール：{me?.guardian.email || '未登録'}</p>
        <label className="block text-sm font-medium">
          電話番号（国番号付き）
          <input
            type="tel"
            autoComplete="tel"
            inputMode="tel"
            className={`${field} mt-2 max-w-sm`}
            value={phone}
            required={selected.includes('sms')}
            pattern="\+81[1-9][0-9]{8,9}"
            placeholder="+819012345678"
            onChange={(e) => {
              setPhone(e.target.value);
              setSaved(false);
            }}
          />
        </label>
        <p className="border-l-2 border-amber-500 pl-3 text-sm leading-6 text-ink/75">
          緊急のお知らせには、通常の通知設定にかかわらず登録済みの連絡先が使われることがあります。電話番号の本人確認・送信確認はまだ行われていません。
        </p>
        <PushRegistration />
        {saveError && (
          <p role="alert" className="text-sm text-alert">
            保存の完了を確認できませんでした。入力内容を確認して、もう一度保存してください。
          </p>
        )}
        <button type="submit" className={`${control} !bg-emerald-700 !text-white`}>
          <Save size={17} aria-hidden />
          {busy ? '保存中' : '設定を保存'}
        </button>
      </fieldset>
      {saved && (
        <p
          role="status"
          className="text-sm text-emerald-800"
          data-testid="notification-settings-saved"
        >
          設定を保存しました。通知の送信確認はしていません。
        </p>
      )}
      <div className="border-t border-ink/15 pt-5">
        <Link className="text-sm text-calm underline" href="/consent">
          同意の確認・取り消し
        </Link>
      </div>
    </form>
  );
}
