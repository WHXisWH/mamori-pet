import type { ConsultChoice, GradeBand, RiskLevel } from '@ijime/api-types';
import type { DocumentSnapshot, Transaction } from '@google-cloud/firestore';
import { SkipEvent, stableId, type EventPayload } from '@ijime/service-kit';
import { z } from 'zod';

import { enqueueSends } from './delivery.js';
import { loadResources, loadTemplate, templateId, type NotifierDeps } from './deps.js';
import { channelsOf, planDeliveries } from './recipients.js';
import { readRoutingBlock, redactNotification } from './routing-safety.js';
import {
  childDocPath,
  findChild,
  listGuardians,
  notificationPath,
  type NotificationDoc,
  type NotificationPayload,
} from './store.js';
import { fillTemplate, type ParsedTemplate } from './templates.js';
import { WRITER_PROMPT, writeCareHint, type Reason, type WriterOutput } from './writer.js';

export const CONSULTATION_TIMEOUT_PATH = '/internal/tasks/consultation-timeout';

const id = z.string().min(1).max(128);
export const consultationTimeoutSchema = z.strictObject({
  familyId: id,
  childId: id,
  consultationId: id,
});
export type ConsultationTimeout = z.infer<typeof consultationTimeoutSchema>;

type ConsultationDoc = {
  assessmentId: string;
  level: RiskLevel;
  choice?: ConsultChoice;
  notificationId?: string;
  familyHarmSuspected?: boolean;
  crisisId?: string;
};

type Child = { childId: string; familyId: string; nickname: string; gradeBand: GradeBand };

export const careHintId = (childId: string, consultationId: string) =>
  `care-${stableId(childId, consultationId)}`;
export const contentFreeId = (childId: string, consultationId: string) =>
  `cfa-${stableId(childId, consultationId)}`;

const consultationPath = (c: Child, consultationId: string) =>
  `${childDocPath(c.familyId, c.childId)}/consultations/${consultationId}`;

async function withConsultation<T>(
  deps: NotifierDeps,
  child: Child,
  consultationId: string,
  expectedChoice: ConsultChoice | undefined,
  write: (tx: Transaction, consult: ConsultationDoc, drafts: DocumentSnapshot[]) => T,
): Promise<T> {
  const result = await deps.db.runTransaction(async (tx) => {
    const consultation = await tx.get(deps.db.doc(consultationPath(child, consultationId)));
    const drafts = await tx.getAll(
      deps.db.doc(notificationPath(child.familyId, careHintId(child.childId, consultationId))),
      deps.db.doc(notificationPath(child.familyId, contentFreeId(child.childId, consultationId))),
    );
    const consult = consultation.data() as ConsultationDoc | undefined;
    const blocked =
      (await readRoutingBlock(tx, deps.db, child.familyId, child.childId)) ??
      (!consult
        ? 'consultation_not_found'
        : consult.familyHarmSuspected || consult.crisisId
          ? 'consultation_unsafe'
          : drafts.some((d) => d.get('status') === 'failed')
            ? 'notification_suppressed'
            : undefined);
    if (blocked) {
      for (const draft of drafts) redactNotification(tx, draft);
      return { blocked } as const;
    }
    if (consult!.choice !== expectedChoice) {
      // A normal late timeout must not retract a valid, confirmed proxy notification.
      for (const draft of drafts) {
        if (
          (draft.get('kind') === 'care_hint' && consult!.choice !== 'proxy') ||
          (draft.get('kind') === 'content_free_alert' &&
            (consult!.level !== 'l3' ||
              (consult!.choice !== undefined && consult!.choice !== 'not_now')))
        )
          redactNotification(tx, draft);
      }
      return { blocked: 'consultation_choice_changed' } as const;
    }
    return { value: write(tx, consult!, drafts) } as const;
  });
  if (result.blocked) throw new SkipEvent(result.blocked);
  return result.value!;
}

async function readReason(deps: NotifierDeps, c: Child, assessmentId: string): Promise<Reason> {
  const snap = await deps.db
    .doc(`${childDocPath(c.familyId, c.childId)}/riskAssessments/${assessmentId}`)
    .get();
  const exp = snap.data()?.['explanation'] as { domains?: string[]; days?: number } | undefined;
  return { domains: exp?.domains ?? [], days: exp?.days ?? 0 };
}

// 静的フォールバック：{days} を含む段落は「変化」を表す。根拠がないときは段落ごと省く
export function staticCareHint(raw: ParsedTemplate, nickname: string, days: number): WriterOutput {
  const changesRaw = raw.paragraphs.filter((p) => p.includes('{days}'));
  const meaningRaw = raw.paragraphs.filter((p) => !p.includes('{days}'));
  const t = fillTemplate(
    { ...raw, paragraphs: [...(days > 0 ? changesRaw : []), ...meaningRaw] },
    { nickname, days },
  );
  const nChanges = days > 0 ? changesRaw.length : 0;
  const split = (s: string | undefined) =>
    (s ?? '')
      .split('、')
      .map((x) => x.trim())
      .filter(Boolean);
  return {
    title: t.title,
    changes: t.paragraphs.slice(0, nChanges),
    meaning: t.paragraphs.slice(nChanges).join('\n'),
    suggestions: { try: split(t.labeled['声かけの例']), avoid: split(t.labeled['避けたいこと']) },
  };
}

async function deliver(
  deps: NotifierDeps,
  child: Child,
  notificationId: string,
  kind: 'care_hint' | 'content_free_alert',
): Promise<number> {
  const guardians = await listGuardians(deps.db, child.familyId);
  const deliveries = planDeliveries(kind, guardians);
  if (deliveries.every((d) => d.channels.length === 0)) {
    deps.logger.error('notify.guardian_unreachable', { notificationId, kind });
  }
  return enqueueSends(deps, child.familyId, notificationId, deliveries, 0);
}

async function recipients(
  deps: NotifierDeps,
  child: Child,
  kind: 'care_hint' | 'content_free_alert',
) {
  const deliveries = planDeliveries(kind, await listGuardians(deps.db, child.familyId));
  return { recipientIds: deliveries.map((d) => d.guardianId), channels: channelsOf(deliveries) };
}

async function sendCareHint(
  deps: NotifierDeps,
  child: Child,
  consultationId: string,
  consult: ConsultationDoc,
): Promise<void> {
  const { db, kb, logger } = deps;
  const notificationId = careHintId(child.childId, consultationId);
  const ref = db.doc(notificationPath(child.familyId, notificationId));
  const snap = await withConsultation(deps, child, consultationId, 'proxy', (_tx, _c, drafts) =>
    drafts.find((d) => d.id === notificationId)!,
  );
  if (!snap.exists) throw new Error('care_hint draft not visible yet');
  const draft = snap.data() as NotificationDoc;

  if (!draft.templateId) {
    const childSummary = draft.payload?.childSummary ?? null;
    const reason = await readReason(deps, child, consult.assessmentId);
    const written = await writeCareHint({
      kb,
      model: deps.model,
      nickname: child.nickname,
      gradeBand: child.gradeBand,
      reason,
      childSummary,
    });
    const raw = await loadTemplate(kb, 'care_hint');
    const body = written.ok ? written.value : staticCareHint(raw, child.nickname, reason.days);
    if (!written.ok) {
      logger.warn('notify.writer_fallback', {
        notificationId,
        reason: written.reason,
        attempts: written.attempts,
      });
    }
    const payload: NotificationPayload = {
      ...body,
      childSummary,
      resources: await loadResources(kb, raw.resourceIds),
      reason,
    };
    const to = await recipients(deps, child, 'care_hint');
    await withConsultation(deps, child, consultationId, 'proxy', (tx, _consult, drafts) => {
      const cur = drafts.find((d) => d.id === notificationId)?.data() as
        NotificationDoc | undefined;
      if (!cur) throw new SkipEvent('notification_missing');
      if (!cur.templateId)
        tx.update(ref, {
          ...to,
          payload,
          templateId: written.ok ? `${WRITER_PROMPT}@${kb.version}` : templateId(kb, 'care_hint'),
        });
      tx.update(db.doc(consultationPath(child, consultationId)), { notificationId });
    });
  }
  const sends = await deliver(deps, child, notificationId, 'care_hint');
  logger.info('notify.care_hint_queued', { notificationId, sends });
}

async function sendContentFree(
  deps: NotifierDeps,
  child: Child,
  consultationId: string,
  level: RiskLevel,
  trigger: 'not_now' | 'timeout',
): Promise<void> {
  const { db, kb, logger } = deps;
  const notificationId = contentFreeId(child.childId, consultationId);
  const t = fillTemplate(await loadTemplate(kb, 'content_free_alert'), {
    nickname: child.nickname,
  });
  const doc: NotificationDoc = {
    childId: child.childId,
    ...(await recipients(deps, child, 'content_free_alert')),
    kind: 'content_free_alert',
    level,
    templateId: templateId(kb, 'content_free_alert'),
    payload: {
      title: t.title,
      changes: [],
      meaning: t.paragraphs.join('\n'),
      suggestions: { try: t.bullets, avoid: [] },
      childSummary: null,
      resources: await loadResources(kb, t.resourceIds),
      reason: { domains: [], days: 0 },
    },
    status: 'queued',
    attempts: [],
    createdAt: deps.now(),
  };
  await withConsultation(
    deps,
    child,
    consultationId,
    trigger === 'timeout' ? undefined : 'not_now',
    (tx, consult, drafts) => {
      if (consult.level !== 'l3') throw new SkipEvent('consultation_not_l3');
      if (!drafts.find((d) => d.id === notificationId)?.exists)
        tx.create(db.doc(notificationPath(child.familyId, notificationId)), doc);
      tx.update(db.doc(consultationPath(child, consultationId)), { notificationId });
    },
  );
  const sends = await deliver(deps, child, notificationId, 'content_free_alert');
  logger.info('notify.content_free_queued', { notificationId, trigger, sends });
}

async function loadConsultation(
  deps: NotifierDeps,
  childId: string,
  consultationId: string,
  expectedChoice: ConsultChoice | undefined,
): Promise<{ child: Child; consult: ConsultationDoc }> {
  const child = await findChild(deps.db, childId);
  if (!child) throw new SkipEvent('child_not_found');
  const consult = await withConsultation(
    deps,
    child,
    consultationId,
    expectedChoice,
    (_tx, c) => c,
  );
  return { child, consult };
}

export async function handleConsultationResolved(
  deps: NotifierDeps,
  ev: EventPayload<'consultation.resolved'>,
): Promise<void> {
  const { child, consult } = await loadConsultation(deps, ev.childId, ev.consultationId, ev.choice);
  if (consult.choice === 'self') return;
  if (ev.choice === 'proxy') return sendCareHint(deps, child, ev.consultationId, consult);
  if (consult.level !== 'l3') {
    deps.logger.info('notify.not_now_no_alert', { consultationId: ev.consultationId });
    return;
  }
  return sendContentFree(deps, child, ev.consultationId, consult.level, 'not_now');
}

export async function handleConsultationTimeout(
  deps: NotifierDeps,
  task: ConsultationTimeout,
): Promise<void> {
  const { child, consult } = await loadConsultation(
    deps,
    task.childId,
    task.consultationId,
    undefined,
  );
  if (child.familyId !== task.familyId) throw new SkipEvent('family_mismatch');
  if (consult.choice) throw new SkipEvent('consultation_answered');
  if (consult.level !== 'l3') throw new SkipEvent('consultation_not_l3');
  return sendContentFree(deps, child, task.consultationId, consult.level, 'timeout');
}
