import type { NotifyChannel } from '@ijime/api-types';
import { GoogleHttpError, type GoogleHttp, type Logger } from '@ijime/service-kit';

import type { GuardianContact } from './recipients.js';

// プッシュ通知と SMS は定型の文言だけを送り、子どもに関する内容は一切含めない
export type OutboundMessage = {
  notificationId: string;
  pushTitle: string;
  pushBody: string;
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
