import { Logger } from '@ijime/service-kit';
import { describe, expect, it, vi } from 'vitest';

import { LogOnlySender } from './channels.js';
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
