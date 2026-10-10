'use client';

import type { InviteReq, InviteRes } from '@ijime/api-types';
import { Copy, Send, UserPlus } from 'lucide-react';
import { useState, type FormEvent } from 'react';

import { GuardianApiError, guardianRequest } from '@/lib/api';
import { control, field, useGuardian } from './GuardianShell';

function inviteError(err: unknown): string {
  if (err instanceof GuardianApiError) {
    if (err.code === 'ALREADY_EXISTS') return 'すでに第二保護者が登録されています。';
    if (err.code === 'RATE_LIMITED')
      return '未使用の招待が多すぎます。期限が切れてから、もう一度お試しください。';
    if (err.code === 'INVALID_ARGUMENT') return err.message;
  }
  return '招待を作成できませんでした。もう一度お試しください。';
}

export function SecondGuardianInvite() {
  const { me } = useGuardian();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [invite, setInvite] = useState<{ link: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = useState(false);
  if (!me?.family.consentComplete) return null;
  if (me.guardian.role !== 'primary')
    return (
      <p className="border-t border-ink/15 pt-5 text-sm text-ink/70" data-testid="secondary-note">
        第二保護者として登録されています。
      </p>
    );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setCopied(false);
    try {
      const body: InviteReq = { email: email.trim() };
      const res = await guardianRequest<InviteRes>('/v1/guardians/invitations', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setInvite({
        link: `${window.location.origin}/invite/${res.invitationId}`,
        expiresAt: res.expiresAt,
      });
    } catch (err) {
      setError(inviteError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="max-w-2xl space-y-4 border-t border-ink/15 py-6" data-testid="invite">
      <h2 className="flex items-center gap-2 text-lg font-bold">
        <UserPlus size={20} aria-hidden />
        もう一人の保護者を招待
      </h2>
      <p className="text-sm leading-6 text-ink/75">
        緊急のお知らせに一定時間応答がないとき、もう一人の保護者にもお知らせが届きます。招待できるのは一人までです。
      </p>
      {invite ? (
        <div className="space-y-3 text-sm" data-testid="invite-created">
          <p>
            次のリンクを相手に送ってください。招待したメールアドレスでログインした人だけが参加できます。
          </p>
          <input
            readOnly
            value={invite.link}
            className={`${field} w-full`}
            aria-label="招待リンク"
            data-testid="invite-link"
            onFocus={(e) => e.target.select()}
          />
          <p className="text-ink/70">
            有効期限：
            {new Date(invite.expiresAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={control}
              onClick={() =>
                void navigator.clipboard.writeText(invite.link).then(
                  () => setCopied(true),
                  () => setCopied(false),
                )
              }
            >
              <Copy size={17} aria-hidden />
              {copied ? 'コピーしました' : 'リンクをコピー'}
            </button>
            {typeof navigator.share === 'function' && (
              <button
                type="button"
                className={control}
                onClick={() =>
                  void navigator
                    .share({ title: 'まもりペット 保護者への招待', url: invite.link })
                    .catch(() => undefined)
                }
              >
                <Send size={17} aria-hidden />
                共有
              </button>
            )}
          </div>
        </div>
      ) : (
        <form onSubmit={(e) => void submit(e)} className="space-y-3">
          <label className="block text-sm font-medium">
            招待する人のメールアドレス
            <input
              type="email"
              required
              autoComplete="off"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={`${field} mt-2 max-w-sm`}
              data-testid="invite-email"
            />
          </label>
          {error && (
            <p role="alert" className="text-sm text-alert" data-testid="invite-error">
              {error}
            </p>
          )}
          <button type="submit" disabled={busy} className={control} data-testid="invite-submit">
            <UserPlus size={17} aria-hidden />
            {busy ? '作成中' : '招待リンクを作る'}
          </button>
        </form>
      )}
    </section>
  );
}
