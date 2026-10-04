import { NOTIFY_CHANNELS } from '@ijime/api-types';
import { SkipEvent, stableId } from '@ijime/service-kit';
import { z } from 'zod';

import { loadTemplate, type NotifierDeps } from './deps.js';
import type { Delivery } from './recipients.js';
import { checkedNotification } from './routing-safety.js';
import { getGuardian, recordAttempt, removeStaleTokens } from './store.js';

export const SEND_TASK_PATH = '/internal/tasks/send';

const id = z.string().min(1).max(128);

export const sendTaskSchema = z.strictObject({
  familyId: id,
  notificationId: id,
  guardianId: id,
  channel: z.enum(NOTIFY_CHANNELS),
  round: z.number().int().nonnegative(),
});
export type SendTask = z.infer<typeof sendTaskSchema>;

export async function enqueueSends(
  deps: NotifierDeps,
  familyId: string,
  notificationId: string,
  deliveries: readonly Delivery[],
  round: number,
): Promise<number> {
  const notification = await checkedNotification(deps.db, familyId, notificationId);
  let n = 0;
  for (const d of deliveries) {
    if (!notification.recipientIds.includes(d.guardianId)) continue;
    for (const channel of d.channels) {
      if (!notification.channels.includes(channel)) continue;
      const body: SendTask = { familyId, notificationId, guardianId: d.guardianId, channel, round };
      await deps.tasks.enqueue({
        queue: 'notify-send',
        url: `${deps.selfUrl}${SEND_TASK_PATH}`,
        body,
        taskId: `send-${stableId(notificationId, d.guardianId, channel, round)}`,
      });
      n++;
    }
  }
  return n;
}

export async function handleSendTask(deps: NotifierDeps, task: SendTask): Promise<void> {
  const { db, logger } = deps;
  const initial = await checkedNotification(db, task.familyId, task.notificationId);

  const guardian = await getGuardian(db, task.familyId, task.guardianId);
  const t = await loadTemplate(deps.kb, initial.kind);
  const msg = {
    notificationId: task.notificationId,
    pushTitle: t.pushTitle,
    pushBody: t.pushBody,
    ...(deps.guardianWebOrigin
      ? { link: `${deps.guardianWebOrigin}/notifications/${task.notificationId}` }
      : {}),
  };
  const notif = await checkedNotification(db, task.familyId, task.notificationId);
  if (task.round > 0 && notif.acknowledgedAt) throw new SkipEvent('already_acknowledged');
  if (!notif.recipientIds.includes(task.guardianId) || !notif.channels.includes(task.channel))
    throw new SkipEvent('notification_recipient_removed');
  const result = guardian
    ? await deps.senders[task.channel].send(guardian, msg)
    : ({ ok: false, reason: 'no_target', retryable: false } as const);

  await recordAttempt(db, task.familyId, task.notificationId, {
    guardianId: task.guardianId,
    channel: task.channel,
    round: task.round,
    at: deps.now(),
    result: result.ok ? 'sent' : result.reason,
  });
  if (result.ok) {
    await removeStaleTokens(db, task.familyId, result.staleTokens ?? []);
    logger.info('notify.sent', {
      notificationId: task.notificationId,
      kind: notif.kind,
      channel: task.channel,
      round: task.round,
      latencyMs: deps.now().getTime() - toDate(notif.createdAt).getTime(),
    });
    return;
  }
  logger.warn('notify.not_sent', {
    notificationId: task.notificationId,
    channel: task.channel,
    reason: result.reason,
  });
  if (result.retryable) throw new Error(`send failed on ${task.channel}`);
}

export function toDate(v: unknown): Date {
  if (v instanceof Date) return v;
  if (v && typeof (v as { toDate?: unknown }).toDate === 'function')
    return (v as { toDate: () => Date }).toDate();
  return new Date(String(v));
}
