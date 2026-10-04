import { randomUUID } from 'node:crypto';

import { FieldValue } from '@google-cloud/firestore';
import type {
  ChoiceReq,
  ChoiceRes,
  ConsultChoice,
  ConsultationRes,
  GradeBand,
  RiskLevel,
  TellAdultRes,
} from '@ijime/api-types';
import { CONSULT_CHOICES } from '@ijime/api-types';
import { consultation as consultConfig, limits } from '@ijime/config';
import { fieldAad } from '@ijime/crypto';
import { crisisResponse } from '@ijime/crisis-detector';
import { ApiHttpError, stableId, type ServiceApp, type ServiceEnv } from '@ijime/service-kit';
import type { Hono } from 'hono';
import { z } from 'zod';

import { childAuth, type AuthEnv } from '../auth.js';
import type { ChatDeps } from '../chat.js';
import { consultationIsPending } from './child-profile.js';
import { childOwner, resourceId, storedDate } from './workflow-store.js';
import { checkWithinBudget } from '../model-budget.js';
import { activeCrisisPayload, activeCrisisQuery, readActiveCrisis } from './workflow-safety.js';

const choiceSchema = z.object({
  choice: z.enum(CONSULT_CHOICES),
  summary: z
    .object({
      text: z.string().trim().min(limits.summaryText.min).max(limits.summaryText.max),
      confirmed: z.boolean(),
    })
    .optional(),
});

type ConsultationDoc = {
  level: RiskLevel;
  choice?: ConsultChoice;
  followUpAt?: unknown;
  offerCount?: number;
  crisisId?: string;
  familyHarmSuspected?: boolean;
};

export const careHintDraftId = (childId: string, consultationId: string) =>
  `care-${stableId(childId, consultationId)}`;

function response(choice: ConsultChoice, level: RiskLevel, coaching: string[]): ChoiceRes {
  if (choice === 'self') return { notificationQueued: false, coachingScript: coaching };
  return { notificationQueued: choice === 'proxy' || level === 'l3' };
}

export function registerConsultations(app: ServiceApp, getDeps: () => Promise<ChatDeps>): void {
  const childRoutes = (app as unknown as Hono<AuthEnv & ServiceEnv>).basePath('/v1/child');
  childRoutes.use('/tell-adult', async (c, next) => childAuth((await getDeps()).auth)(c, next));
  childRoutes.post('/tell-adult', async (c) => {
    const deps = await getDeps();
    const { child, base, ref } = await childOwner(deps, c.get('child').childId);
    const key = c.req.header('Idempotency-Key');
    if (key) resourceId(key);
    const id = key ? `tell-${stableId(child.childId, key)}` : randomUUID();
    const target = deps.db.doc(`${base}/consultations/${id}`);
    const result = await deps.db.runTransaction(async (tx): Promise<TellAdultRes> => {
      const owner = await tx.get(ref);
      const active = await tx.get(activeCrisisQuery(deps, base));
      const crisis = activeCrisisPayload(deps, child.gradeBand, active.docs);
      if (crisis) return { crisis };
      const existing = await tx.get(target);
      const recent = await tx.get(
        deps.db
          .collection(`${base}/consultations`)
          .orderBy('offeredAt', 'desc')
          .limit(limits.pageSize.max),
      );
      if (owner.get('status') !== 'active')
        throw new ApiHttpError('PERMISSION_DENIED', '利用できません');
      if (existing.exists) return { consultationId: existing.id };
      const pending = recent.docs.find((d) => consultationIsPending(d.data()));
      if (pending) return { consultationId: pending.id };
      tx.create(target, {
        assessmentId: 'child-request',
        level: 'l2',
        source: 'child',
        offeredAt: new Date(),
        offerCount: 1,
      });
      tx.update(ref, { consultationRevision: FieldValue.increment(1) });
      return { consultationId: target.id };
    });
    return c.json(result, result.crisis ? 200 : 201);
  });

  const r = (app as unknown as Hono<AuthEnv & ServiceEnv>).basePath('/v1/child/consultations');
  r.use('*', async (c, next) => childAuth((await getDeps()).auth)(c, next));

  r.get('/:consultationId', async (c) => {
    const deps = await getDeps();
    const { child, base } = await childOwner(deps, c.get('child').childId);
    const id = resourceId(c.req.param('consultationId'));
    const data = (await deps.db.doc(`${base}/consultations/${id}`).get()).data();
    if (!data) throw new ApiHttpError('NOT_FOUND', 'unknown consultation');
    const choice = data['choice'] as ConsultChoice | undefined;
    const due = storedDate(data['followUpAt']);
    const crisis = await readActiveCrisis(deps, child.gradeBand, base);
    const body: ConsultationRes = {
      consultationId: id,
      status: consultationIsPending(data) ? 'pending' : 'answered',
      choices: crisis ? [] : [...CONSULT_CHOICES],
      offeredAt: storedDate(data['offeredAt'])!.toISOString(),
      notificationQueued:
        !crisis &&
        !data['familyHarmSuspected'] &&
        (!!data['notificationId'] ||
          (!data['crisisId'] &&
            !data['familyHarmSuspected'] &&
            (choice === 'proxy' || (choice === 'not_now' && data['level'] === 'l3')))),
      ...(choice ? { choice } : {}),
      ...(due ? { followUpAt: due.toISOString() } : {}),
      ...(choice === 'self' && !crisis ? { coachingScript: deps.coaching[child.gradeBand] } : {}),
      ...(crisis ? { crisis } : {}),
    };
    return c.json(body);
  });

  r.post('/:consultationId/choice', async (c) => {
    const deps = await getDeps();
    const { childId } = c.get('child');
    const consultationId = resourceId(c.req.param('consultationId'));
    const parsed = choiceSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ApiHttpError('INVALID_ARGUMENT', '回答の形式が正しくありません');
    const req = parsed.data satisfies Omit<ChoiceReq, 'summary'>;
    if (req.choice === 'proxy' && !req.summary?.confirmed)
      throw new ApiHttpError('INVALID_ARGUMENT', 'つたえる ことばを かくにんしてね');

    const { child, base, ref: childRef } = await childOwner(deps, childId);
    const path = `${base}/consultations/${consultationId}`;
    const ref = deps.db.doc(path);
    const snap = await ref.get();
    if (!snap.exists) throw new ApiHttpError('NOT_FOUND', 'unknown consultation');
    const level = (snap.data() as ConsultationDoc).level;
    const coaching = deps.coaching[child.gradeBand as GradeBand];
    const now = new Date();
    const log = deps.logger;

    const existing = snap.data() as ConsultationDoc;
    const activeCrisis = await readActiveCrisis(deps, child.gradeBand, base);
    if (activeCrisis)
      return c.json({ notificationQueued: false, crisis: activeCrisis } satisfies ChoiceRes);
    if (existing.familyHarmSuspected)
      throw new ApiHttpError(
        'PERMISSION_DENIED',
        'この相談は家族に送れません。相談窓口を利用してください',
      );
    if (existing.choice && !consultationIsPending(snap.data()!)) {
      if (existing.choice !== req.choice)
        throw new ApiHttpError('ALREADY_EXISTS', 'consultation already answered');
      if (existing.crisisId) {
        const event = (await deps.db.doc(`${base}/crisisEvents/${existing.crisisId}`).get()).data();
        const familyHarmSuspected = event?.['familyHarmSuspected'] !== false;
        return c.json({
          notificationQueued: false,
          crisis: {
            crisisId: existing.crisisId,
            ...crisisResponse({
              familyHarmSuspected,
              gradeBand: child.gradeBand,
              copy: deps.safeModeCopy,
              hotlines: deps.hotlines,
            }),
          },
        } satisfies ChoiceRes);
      }
      const beforeRetryPublish = await readActiveCrisis(deps, child.gradeBand, base);
      if (beforeRetryPublish)
        return c.json({
          notificationQueued: false,
          crisis: beforeRetryPublish,
        } satisfies ChoiceRes);
      await deps.publish('consultation.resolved', { childId, consultationId, choice: req.choice });
      return c.json(response(req.choice, level, coaching));
    }

    if (req.summary) {
      const check = await checkWithinBudget(deps, child, base, {
        text: req.summary.text,
        gradeBand: child.gradeBand,
        priorTurns: [],
      });
      log.info('crisis.check', {
        pseudoId: childId,
        consultationId,
        hit: check.hit,
        method: check.method,
        category: check.category,
        latencyMs: Math.round(check.latencyMs),
      });
      if (check.hit) {
        const crisisRef = deps.db.doc(
          `${base}/crisisEvents/consult-${stableId(childId, consultationId)}`,
        );
        const concurrentCrisis = await deps.db.runTransaction(async (tx) => {
          const cur = await tx.get(ref);
          const priorCrisis = await tx.get(crisisRef);
          const owner = await tx.get(childRef);
          const active = await tx.get(activeCrisisQuery(deps, base));
          const crisis = activeCrisisPayload(deps, child.gradeBand, active.docs);
          if (crisis) return crisis;
          if (!cur.exists) throw new ApiHttpError('NOT_FOUND', 'unknown consultation');
          if (owner.get('status') !== 'active')
            throw new ApiHttpError('PERMISSION_DENIED', '利用できません');
          if (
            cur.get('choice') &&
            cur.get('choice') !== req.choice &&
            !consultationIsPending(cur.data()!, now)
          )
            throw new ApiHttpError('ALREADY_EXISTS', 'consultation already answered');
          if (!priorCrisis.exists)
            tx.create(crisisRef, {
              triggerType: 'text',
              sourceRef: path,
              detection: {
                keywordMatched: check.keywordMatched,
                method: check.method,
                category: check.category,
                confidence: check.confidence,
                availability: check.availability ?? 'verified',
              },
              familyHarmSuspected: check.familyHarmSuspected,
              timeline: [{ step: 'safe_mode_shown', at: now }],
              status: 'open',
              createdAt: now,
            });
          tx.update(ref, { choice: req.choice, choiceAt: now, crisisId: crisisRef.id });
          return undefined;
        });
        if (concurrentCrisis)
          return c.json({
            notificationQueued: false,
            crisis: concurrentCrisis,
          } satisfies ChoiceRes);
        const currentCrisis = await readActiveCrisis(deps, child.gradeBand, base);
        if (currentCrisis && currentCrisis.crisisId !== crisisRef.id)
          return c.json({ notificationQueued: false, crisis: currentCrisis } satisfies ChoiceRes);
        await deps.publish('crisis.detected', {
          childId,
          crisisId: crisisRef.id,
          familyHarmSuspected: check.familyHarmSuspected,
        });
        log.warn('crisis.detected', {
          pseudoId: childId,
          crisisId: crisisRef.id,
          category: check.category,
          familyHarmSuspected: check.familyHarmSuspected,
          source: 'consultation_summary',
        });
        const body: ChoiceRes = {
          notificationQueued: !check.familyHarmSuspected,
          crisis: {
            crisisId: crisisRef.id,
            ...crisisResponse({
              familyHarmSuspected: check.familyHarmSuspected,
              gradeBand: child.gradeBand,
              copy: deps.safeModeCopy,
              hotlines: deps.hotlines,
            }),
          },
        };
        return c.json(body);
      }
    }

    const draftRef = deps.db.doc(
      `families/${child.familyId}/notifications/${careHintDraftId(childId, consultationId)}`,
    );
    const lateCrisis = await deps.db.runTransaction(async (tx) => {
      const cur = await tx.get(ref);
      const draft = await tx.get(draftRef);
      const owner = await tx.get(childRef);
      const active = await tx.get(activeCrisisQuery(deps, base));
      const crisis = activeCrisisPayload(deps, child.gradeBand, active.docs);
      if (crisis) return crisis;
      if (!cur.exists) throw new ApiHttpError('NOT_FOUND', 'unknown consultation');
      if (owner.get('status') !== 'active')
        throw new ApiHttpError('PERMISSION_DENIED', '利用できません');
      const prev = (cur.data() as ConsultationDoc | undefined)?.choice;
      const followUp = !!prev && consultationIsPending(cur.data()!, now);
      if (prev && !followUp && prev !== req.choice)
        throw new ApiHttpError('ALREADY_EXISTS', 'consultation already answered');
      if (prev && !followUp) return;
      const update: Record<string, unknown> = { choice: req.choice, choiceAt: now };
      if (followUp) update['offerCount'] = FieldValue.increment(1);
      if (existing.familyHarmSuspected && req.choice === 'proxy')
        throw new ApiHttpError(
          'PERMISSION_DENIED',
          'この相談は家族に送れません。相談窓口を利用してください',
        );
      if (req.choice === 'proxy' && req.summary) {
        update['summaryEnc'] = deps.sessions.encryptForChild(
          child,
          req.summary.text,
          fieldAad(path, 'summaryEnc'),
        );
        update['childConfirmedSummary'] = true;
        if (!draft.exists) {
          tx.create(draftRef, {
            childId,
            recipientIds: [],
            kind: 'care_hint',
            level,
            templateId: '',
            payload: { childSummary: req.summary.text },
            channels: [],
            status: 'queued',
            attempts: [],
            createdAt: now,
          });
        }
      }
      if ((req.choice === 'not_now' && level === 'l2') || req.choice === 'self') {
        update['followUpAt'] = new Date(now.getTime() + consultConfig.l2FollowUpDays * 86_400_000);
      }
      tx.update(ref, update);
      return undefined;
    });

    if (lateCrisis)
      return c.json({ notificationQueued: false, crisis: lateCrisis } satisfies ChoiceRes);
    const beforePublish = await readActiveCrisis(deps, child.gradeBand, base);
    if (beforePublish)
      return c.json({ notificationQueued: false, crisis: beforePublish } satisfies ChoiceRes);

    await deps.publish('consultation.resolved', { childId, consultationId, choice: req.choice });
    log.info('consultation.resolved', { pseudoId: childId, consultationId, choice: req.choice });
    return c.json(response(req.choice, level, coaching));
  });
}
