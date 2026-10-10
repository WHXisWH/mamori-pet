import { Logger } from '@ijime/service-kit';
import { describe, expect, it, vi } from 'vitest';

import { GmailSender, gmailCredentialsSchema, LogOnlySender } from './channels.js';
import type { GuardianContact } from './recipients.js';

const to: GuardianContact = {
  guardianId: 'g1',
  email: 'fixture@example.test',
  phoneE164: '+819000000000',
  fcmTokens: [],
  notifyChannels: ['email', 'sms'],
};
const message = { notificationId: 'n1', pushTitle: 'お知らせ', pushBody: '確認してください' };

describe('unconfigured notification channels', () => {
  it.each(['email', 'sms'] as const)(
    'cannot report %s delivered in production',
    async (channel) => {
      const logs: string[] = [];
      const sender = new LogOnlySender(
        channel,
        new Logger('test', (line) => logs.push(line)),
        true,
      );
      expect(await sender.send(to, message)).toEqual({
        ok: false,
        reason: 'rejected',
        retryable: false,
      });
      expect(sender.sent).toEqual([]);
      expect(logs.join('')).toContain('notify.channel_not_configured');
      expect(logs.join('')).not.toContain(to.email);
      expect(logs.join('')).not.toContain(to.phoneE164);
    },
  );

  it('uses the production environment by default', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    try {
      const sender = new LogOnlySender('sms', new Logger('test', () => {}));
      expect((await sender.send(to, message)).ok).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('retains explicit development test behavior without logging contact details', async () => {
    const sender = new LogOnlySender('email', new Logger('test', () => {}), false);
    expect(await sender.send(to, message)).toEqual({ ok: true, delivered: 1 });
    expect(sender.sent).toEqual([{ channel: 'email', guardianId: 'g1', notificationId: 'n1' }]);
  });
});

describe('GmailSender', () => {
  const creds = {
    clientId: 'cid',
    clientSecret: 'csecret',
    refreshToken: 'rtoken',
    sender: 'mamori-notify@example.test',
  };
  const mail = {
    ...message,
    email: {
      subject: '【緊急】お知らせ',
      body: '保護者アプリを開いてください。\n\nhttps://g.example/n/n1',
    },
  };
  type Call = { url: string; init: RequestInit };

  function fakeFetch(sendResponses: (() => Response)[], tokenStatus = 200) {
    const calls: Call[] = [];
    const impl = (async (url: string | URL | Request, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).includes('oauth2')) {
        return tokenStatus === 200
          ? Response.json({ access_token: 'at-1', expires_in: 3600 })
          : new Response('{"error":"invalid_grant"}', { status: tokenStatus });
      }
      const next = sendResponses.shift();
      return next ? next() : Response.json({ id: 'm1' });
    }) as typeof fetch;
    return { calls, impl };
  }

  function sender(sendResponses: (() => Response)[] = [], tokenStatus = 200) {
    const logs: string[] = [];
    const f = fakeFetch(sendResponses, tokenStatus);
    const s = new GmailSender(
      creds,
      new Logger('test', (l) => logs.push(l)),
      f.impl,
      () => 1_000_000,
    );
    return { s, logs, calls: f.calls };
  }

  const gmailError = (status: number, reason: string, msg = 'x') =>
    Response.json({ error: { code: status, message: msg, errors: [{ reason }] } }, { status });

  it('sends a UTF-8 MIME message from the sender account and reuses the access token', async () => {
    const { s, calls, logs } = sender();
    expect(await s.send(to, mail)).toEqual({ ok: true, delivered: 1 });
    expect(await s.send(to, mail)).toEqual({ ok: true, delivered: 1 });
    expect(calls.filter((c) => c.url.includes('oauth2'))).toHaveLength(1);
    const send = calls.find((c) => c.url.includes('gmail'))!;
    expect((send.init.headers as Record<string, string>)['Authorization']).toBe('Bearer at-1');
    const raw = Buffer.from(
      (JSON.parse(String(send.init.body)) as { raw: string }).raw,
      'base64url',
    ).toString('utf8');
    expect(raw).toContain('From: mamori-notify@example.test\r\n');
    expect(raw).toContain(`To: ${to.email}\r\n`);
    expect(raw).toContain(
      `Subject: =?UTF-8?B?${Buffer.from('【緊急】お知らせ').toString('base64')}?=`,
    );
    const body = raw.split('\r\n\r\n')[1]!.replace(/\r\n/g, '');
    expect(Buffer.from(body, 'base64').toString('utf8')).toBe(mail.email.body);
    expect(logs.join('')).not.toContain(to.email);
  });

  it('falls back to the push text when a template has no email lines', async () => {
    const { s, calls } = sender();
    await s.send(to, message);
    const raw = Buffer.from(
      (JSON.parse(String(calls.at(-1)!.init.body)) as { raw: string }).raw,
      'base64url',
    ).toString('utf8');
    expect(raw).toContain(Buffer.from('お知らせ').toString('base64'));
  });

  it('refuses addresses that could inject headers', async () => {
    const { s, calls } = sender();
    for (const email of ['a@example.test\r\nBcc: x@example.test', 'a b@example.test', undefined]) {
      const target = { ...to, ...(email ? { email } : { email: undefined }) };
      expect(await s.send(target as GuardianContact, mail)).toEqual({
        ok: false,
        reason: 'no_target',
        retryable: false,
      });
    }
    expect(calls).toHaveLength(0);
  });

  it('reports invalid credentials once per send as an alertable error, not a retry', async () => {
    const { s, logs } = sender([], 400);
    expect(await s.send(to, mail)).toEqual({ ok: false, reason: 'rejected', retryable: false });
    expect(logs.join('')).toContain('notify.email_auth_failed');
    expect(logs.join('')).not.toContain(to.email);
    expect(logs.join('')).not.toContain('rtoken');
  });

  it('retries rate limits and server errors through notify-send', async () => {
    const { s } = sender([
      () => gmailError(429, 'rateLimitExceeded'),
      () => gmailError(403, 'userRateLimitExceeded'),
      () => new Response('', { status: 503 }),
    ]);
    for (let i = 0; i < 3; i++)
      expect(await s.send(to, mail)).toEqual({ ok: false, reason: 'rejected', retryable: true });
  });

  it('stops retrying and alerts when the daily sending limit is reached', async () => {
    const { s, logs } = sender([
      () => gmailError(403, 'dailyLimitExceeded'),
      () => gmailError(429, 'rateLimitExceeded', 'User-rate limit exceeded: Mail sending limit'),
    ]);
    expect(await s.send(to, mail)).toEqual({ ok: false, reason: 'rejected', retryable: false });
    expect(await s.send(to, mail)).toEqual({ ok: false, reason: 'rejected', retryable: false });
    expect(logs.filter((l) => l.includes('notify.email_quota_exhausted'))).toHaveLength(2);
  });

  it('drops a revoked access token and retries', async () => {
    const { s, calls } = sender([() => new Response('', { status: 401 })]);
    expect((await s.send(to, mail)).ok).toBe(false);
    expect((await s.send(to, mail)).ok).toBe(true);
    expect(calls.filter((c) => c.url.includes('oauth2'))).toHaveLength(2);
  });

  it('does not retry a permanently rejected message', async () => {
    const { s, logs } = sender([() => gmailError(400, 'invalidArgument')]);
    expect(await s.send(to, mail)).toEqual({ ok: false, reason: 'rejected', retryable: false });
    expect(logs.join('')).toContain('notify.email_rejected');
  });

  it('validates the credentials secret', () => {
    expect(gmailCredentialsSchema.safeParse(creds).success).toBe(true);
    expect(gmailCredentialsSchema.safeParse({ ...creds, sender: 'nope' }).success).toBe(false);
    expect(gmailCredentialsSchema.safeParse({ ...creds, extra: 1 }).success).toBe(false);
  });
});
