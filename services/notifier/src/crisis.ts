import { crisis as crisisConfig } from '@ijime/config';
import { SkipEvent, stableId, type EventPayload } from '@ijime/service-kit';
import { z } from 'zod';

import { enqueueSends } from './delivery.js';
import { loadResources, loadTemplate, templateId, type NotifierDeps } from './deps.js';
import { planDeliveries, channelsOf } from './recipients.js';
import { readRoutingBlock, redactNotification } from './routing-safety.js';
import {
  appendCrisisTimeline,
  createNotification,
  crisisPath,
  findChild,
  listGuardians,
  notificationPath,
  type NotificationDoc,
  type NotificationPayload,
} from './store.js';
import { fillTemplate } from './templates.js';

export const ESCALATION_TASK_PATH = '/internal/tasks/crisis-escalation';

const id = z.string().min(1).max(128);
export const escalationTaskSchema = z.strictObject({
  familyId: id,
  childId: id,
  crisisId: id,
  notificationId: id,
  round: z.number().int().positive(),
});
export type EscalationTask = z.infer<typeof escalationTaskSchema>;

export function crisisNotificationId(childId: string, crisisId: string): string {
  return `crisis-${stableId(childId, crisisId)}`;
}

export async function buildCrisisPayload(
  deps: Pick<NotifierDeps, 'kb'>,
  nickname: string,
): Promise<NotificationPayload> {
  const t = fillTemplate(await loadTemplate(deps.kb, 'crisis'), { nickname });
  return {
    title: t.title,
    changes: [],
    meaning: t.paragraphs.join('\n'),
    suggestions: { try: t.bullets, avoid: [] },
    childSummary: null,
    resources: await loadResources(deps.kb, t.resourceIds),
    reason: { domains: [], days: 0 },
  };
}

async function enqueueEscalation(deps: NotifierDeps, task: EscalationTask): Promise<void> {
  const minutes =
    task.round === 1 ? crisisConfig.guardianAckTimeoutMinutes : crisisConfig.resendIntervalMinutes;
  await deps.tasks.enqueue({
    queue: 'crisis-escalation',
    url: `${deps.selfUrl}${ESCALATION_TASK_PATH}`,
    body: task,
    delaySeconds: minutes * 60,
    taskId: `esc-${stableId(task.notificationId, task.round)}`,
  });
}

export async function handleCrisisDetected(
  deps: NotifierDeps,
  ev: EventPayload<'crisis.detected'>,
): Promise<void> {
  const { db, logger } = deps;
  if (ev.familyHarmSuspected) {
    logger.info('crisis.guardian_notify_suppressed', { crisisId: ev.crisisId });
    return;
  }
  const child = await findChild(db, ev.childId);
  if (!child) throw new SkipEvent('child_not_found');
  const crisisSnap = await db.doc(crisisPath(child.familyId, ev.childId, ev.crisisId)).get();
  if (!crisisSnap.exists) throw new Error('crisis event not visible yet');
  if ((crisisSnap.data() as { familyHarmSuspected?: boolean }).familyHarmSuspected) {
    logger.info('crisis.guardian_notify_suppressed', { crisisId: ev.crisisId });
    return;
  }

  const guardians = await listGuardians(db, child.familyId);
  const deliveries = planDeliveries('crisis', guardians);
  const notificationId = crisisNotificationId(ev.childId, ev.crisisId);
  const now = deps.now();
  const doc: NotificationDoc = {
    childId: ev.childId,
    recipientIds: deliveries.map((d) => d.guardianId),
    kind: 'crisis',
    level: 'l4',
    templateId: templateId(deps.kb, 'crisis'),
    payload: await buildCrisisPayload(deps, child.nickname),
    channels: channelsOf(deliveries),
    status: 'queued',
    attempts: [],
    createdAt: now,
  };
  const created = await createNotification(db, child.familyId, notificationId, doc);
  if (created) {
    await appendCrisisTimeline(
      db,
      child,
      ev.crisisId,
      { step: 'guardian_notified', at: now },
      { notificationId },
    );
  }
  const unreachable = deliveries.filter((d) => d.channels.length === 0).length;
  if (deliveries.length === 0 || unreachable > 0) {
    logger.error('crisis.guardian_unreachable', {
      crisisId: ev.crisisId,
      guardians: deliveries.length,
      unreachable,
    });
  }
  // タスク ID が決定論的なので、重複配信でも重ねて送信しない
  const sends = await enqueueSends(deps, child.familyId, notificationId, deliveries, 0);
  await enqueueEscalation(deps, {
    familyId: child.familyId,
    childId: ev.childId,
    crisisId: ev.crisisId,
    notificationId,
    round: 1,
  });
  logger.warn('crisis.notification_queued', { crisisId: ev.crisisId, notificationId, sends });
}

export async function handleEscalation(deps: NotifierDeps, task: EscalationTask): Promise<void> {
  const { db, logger } = deps;
  const snap = await db.doc(notificationPath(task.familyId, task.notificationId)).get();
  if (!snap.exists) throw new SkipEvent('notification_missing');
  const notif = snap.data() as NotificationDoc;
  if (notif.acknowledgedAt) {
    logger.info('crisis.escalation_stopped', {
      notificationId: task.notificationId,
      round: task.round,
    });
    return;
  }
  if (task.round > crisisConfig.maxResendRounds) {
    logger.error('crisis.escalation_exhausted', {
      notificationId: task.notificationId,
      round: task.round,
    });
    return;
  }
  // 保護者を読み直す。その間に新しく登録された保護者とデバイスにも届くようにする
  const guardians = await listGuardians(db, task.familyId);
  const deliveries = planDeliveries('crisis', guardians);
  const refreshed = await db.runTransaction(async (tx) => {
    const ref = db.doc(notificationPath(task.familyId, task.notificationId));
    const current = await tx.get(ref);
    if (!current.exists) return { blocked: 'notification_missing' } as const;
    const notification = current.data() as NotificationDoc;
    const blocked =
      (await readRoutingBlock(tx, db, task.familyId, notification.childId)) ??
      (notification.status === 'failed' ? 'notification_suppressed' : undefined);
    if (blocked) {
      redactNotification(tx, current);
      return { blocked } as const;
    }
    if (notification.acknowledgedAt) return { acknowledged: true } as const;
    tx.update(ref, {
      recipientIds: [
        ...new Set([...notification.recipientIds, ...deliveries.map((d) => d.guardianId)]),
      ],
      channels: [...new Set([...notification.channels, ...channelsOf(deliveries)])],
    });
    return { acknowledged: false } as const;
  });
  if (refreshed.blocked) throw new SkipEvent(refreshed.blocked);
  if (refreshed.acknowledged) {
    logger.info('crisis.escalation_stopped', {
      notificationId: task.notificationId,
      round: task.round,
    });
    return;
  }
  const sends = await enqueueSends(
    deps,
    task.familyId,
    task.notificationId,
    deliveries,
    task.round,
  );
  await appendCrisisTimeline(db, task, task.crisisId, {
    step: 'resent',
    round: task.round,
    at: deps.now(),
  });
  await enqueueEscalation(deps, { ...task, round: task.round + 1 });
  logger.warn('crisis.resent', { notificationId: task.notificationId, round: task.round, sends });
}
