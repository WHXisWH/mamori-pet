import type { NotifyChannel } from '@ijime/api-types';
import { outbound } from '@ijime/config';
import { GoogleHttpError, type GoogleHttp, type Logger } from '@ijime/service-kit';
import { z } from 'zod';

import type { GuardianContact } from './recipients.js';

// プッシュ通知と SMS は定型の文言だけを送り、子どもに関する内容は一切含めない
export type OutboundMessage = {
  notificationId: string;
  pushTitle: string;
  pushBody: string;
  email?: { subject: string; body: string };
  link?: string;
};

export type SendResult =
  | { ok: true; delivered: number; staleTokens?: string[] }
  | { ok: false; reason: 'no_target' | 'rejected'; retryable: boolean };

export interface ChannelSender {
  send(to: GuardianContact, msg: OutboundMessage): Promise<SendResult>;
}

export type ChannelSenders = Record<NotifyChannel, ChannelSender>;

export class FcmSender implements ChannelSender {
  constructor(
    private readonly projectId: string,
    private readonly http: GoogleHttp,
  ) {}

  async send(to: GuardianContact, msg: OutboundMessage): Promise<SendResult> {
    if (to.fcmTokens.length === 0) return { ok: false, reason: 'no_target', retryable: false };
    let delivered = 0;
    let transient = 0;
    const staleTokens: string[] = [];
    for (const token of to.fcmTokens) {
      try {
        await this.http.request({
          url: `https://fcm.googleapis.com/v1/projects/${this.projectId}/messages:send`,
          method: 'POST',
          body: {
            message: {
              token,
              webpush: {
                notification: { title: msg.pushTitle, body: msg.pushBody },
                ...(msg.link ? { fcm_options: { link: msg.link } } : {}),
              },
              data: { notificationId: msg.notificationId },
            },
          },
          timeoutMs: outbound.googleApiTimeoutMs,
        });
        delivered++;
      } catch (err) {
        if (err instanceof GoogleHttpError && (err.status === 404 || err.status === 400))
          staleTokens.push(token);
        else transient++;
      }
    }
    if (delivered > 0) return { ok: true, delivered, staleTokens };
    return { ok: false, reason: 'rejected', retryable: transient > 0 };
  }
}

export const gmailCredentialsSchema = z.strictObject({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  refreshToken: z.string().min(1),
  sender: z.email(),
});
export type GmailCredentials = z.infer<typeof gmailCredentialsSchema>;

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const HEADER_SAFE_EMAIL = /^[^\s@<>",;]+@[^\s@<>",;]+$/;

class GmailAuthError extends Error {}

function encodedWord(text: string): string {
  return `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`;
}

export function gmailRaw(from: string, to: string, subject: string, body: string): string {
  const content = (
    Buffer.from(body, 'utf8')
      .toString('base64')
      .match(/.{1,76}/g) ?? []
  ).join('\r\n');
  const mime = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodedWord(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    content,
  ].join('\r\n');
  return Buffer.from(mime, 'utf8').toString('base64url');
}

// MVP デモ用のメールチャネル（2026-10-05 決定）：送信アカウントの OAuth リフレッシュトークンで Gmail API を呼び出す。
// ログには notificationId と guardianId だけを記録し、メールアドレスは記録しない
export class GmailSender implements ChannelSender {
  private token: { value: string; expiresAt: number } | undefined;

  constructor(
    private readonly creds: GmailCredentials,
    private readonly logger: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async send(to: GuardianContact, msg: OutboundMessage): Promise<SendResult> {
    if (!to.email || !HEADER_SAFE_EMAIL.test(to.email))
      return { ok: false, reason: 'no_target', retryable: false };
    const ids = { notificationId: msg.notificationId, guardianId: to.guardianId };
    let access: string;
    try {
      access = await this.accessToken();
    } catch (err) {
      if (err instanceof GmailAuthError) {
        this.logger.error('notify.email_auth_failed', ids);
        return { ok: false, reason: 'rejected', retryable: false };
      }
      return { ok: false, reason: 'rejected', retryable: true };
    }
    const email = msg.email ?? { subject: msg.pushTitle, body: msg.pushBody };
    let res: Response;
    try {
      res = await this.fetchImpl(GMAIL_SEND_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          raw: gmailRaw(this.creds.sender, to.email, email.subject, email.body),
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      return { ok: false, reason: 'rejected', retryable: true };
    }
    if (res.ok) return { ok: true, delivered: 1 };
    if (res.status === 401) {
      this.token = undefined;
      return { ok: false, reason: 'rejected', retryable: true };
    }
    const reason = await gmailErrorReason(res);
    if (reason === 'quota') {
      this.logger.error('notify.email_quota_exhausted', ids);
      return { ok: false, reason: 'rejected', retryable: false };
    }
    if (reason === 'rate' || res.status === 429 || res.status >= 500)
      return { ok: false, reason: 'rejected', retryable: true };
    this.logger.error('notify.email_rejected', { ...ids, status: res.status });
    return { ok: false, reason: 'rejected', retryable: false };
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > this.now()) return this.token.value;
    const res = await this.fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: this.creds.clientId,
        client_secret: this.creds.clientSecret,
        refresh_token: this.creds.refreshToken,
      }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 400 || res.status === 401) throw new GmailAuthError('invalid_grant');
    if (!res.ok) throw new Error(`token endpoint ${res.status}`);
    const body = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== 'string') throw new Error('token endpoint returned no token');
    const ttl = typeof body.expires_in === 'number' ? body.expires_in : 3600;
    this.token = { value: body.access_token, expiresAt: this.now() + (ttl - 60) * 1000 };
    return this.token.value;
  }
}

// 1日あたりの送信上限：Gmail は 403 dailyLimitExceeded / quotaExceeded、または 429 に “sending limit” を添えて返し、リトライしても成功しない。
// 403 rateLimitExceeded / userRateLimitExceeded は短時間のレート制限なのでリトライできる
async function gmailErrorReason(res: Response): Promise<'quota' | 'rate' | 'other'> {
  const body = (await res.json().catch(() => null)) as {
    error?: { message?: unknown; errors?: { reason?: unknown }[] };
  } | null;
  const reasons = (body?.error?.errors ?? []).map((e) => e.reason);
  const message = typeof body?.error?.message === 'string' ? body.error.message : '';
  if (reasons.some((r) => r === 'dailyLimitExceeded' || r === 'quotaExceeded')) return 'quota';
  if (/sending limit/i.test(message)) return 'quota';
  if (reasons.some((r) => r === 'rateLimitExceeded' || r === 'userRateLimitExceeded'))
    return 'rate';
  return 'other';
}

// メールと SMS のプロバイダーが決まるまでのダミー実装：ID だけを記録する
export class LogOnlySender implements ChannelSender {
  readonly sent: { channel: NotifyChannel; guardianId: string; notificationId: string }[] = [];

  constructor(
    private readonly channel: NotifyChannel,
    private readonly logger: Logger,
    private readonly production = process.env['NODE_ENV'] === 'production',
  ) {}

  async send(to: GuardianContact, msg: OutboundMessage): Promise<SendResult> {
    if (this.production) {
      this.logger.error('notify.channel_not_configured', {
        channel: this.channel,
        notificationId: msg.notificationId,
      });
      return { ok: false, reason: 'rejected', retryable: false };
    }
    const target = this.channel === 'email' ? to.email : to.phoneE164;
    if (!target) return { ok: false, reason: 'no_target', retryable: false };
    this.sent.push({
      channel: this.channel,
      guardianId: to.guardianId,
      notificationId: msg.notificationId,
    });
    this.logger.info('notify.fake_send', {
      channel: this.channel,
      guardianId: to.guardianId,
      notificationId: msg.notificationId,
    });
    return { ok: true, delivered: 1 };
  }
}

export class MemorySender implements ChannelSender {
  readonly sent: { guardianId: string; msg: OutboundMessage }[] = [];
  failNext = 0;

  async send(to: GuardianContact, msg: OutboundMessage): Promise<SendResult> {
    if (this.failNext > 0) {
      this.failNext--;
      return { ok: false, reason: 'rejected', retryable: true };
    }
    this.sent.push({ guardianId: to.guardianId, msg });
    return { ok: true, delivered: 1 };
  }
}
