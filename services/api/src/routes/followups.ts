import { FieldValue, type DocumentData } from '@google-cloud/firestore';
import type { FollowupAnswerRes, FollowupsRes } from '@ijime/api-types';
import { consultation, limits } from '@ijime/config';
import { ApiHttpError, stableId, type ServiceApp, type ServiceEnv } from '@ijime/service-kit';
import type { Hono } from 'hono';
import { z } from 'zod';

import { childAuth, type AuthEnv } from '../auth.js';
import type { ChatDeps } from '../chat.js';
import { childOwner, resourceId, storedDate } from './workflow-store.js';

type Kind = 'consultation' | 'crisis';

function followupDue(kind: Kind, data: DocumentData): Date | undefined {
  if (data['followUpAnsweredAt']) return undefined;
  if (kind === 'crisis') {
    const scheduled = storedDate(data['followUpAt']);
    if (scheduled) return scheduled;
    const created = storedDate(data['createdAt']);
    return created ? new Date(created.getTime() + 86_400_000) : undefined;
  }
  if (
    data['closedAt'] ||
    data['crisisId'] ||
    !['self', 'proxy', 'not_now'].includes(data['choice'])
  )
    return undefined;
  if (
    data['choice'] === 'not_now' &&
    (data['level'] !== 'l2' || Number(data['offerCount'] ?? 1) >= consultation.l2MaxOffers)
  )
    return undefined;
  return storedDate(data['followUpAt']);
}

export function registerFollowups(app: ServiceApp, getDeps: () => Promise<ChatDeps>): void {
  const r = (app as unknown as Hono<AuthEnv & ServiceEnv>).basePath('/v1/child/followups');
  r.use('*', async (c, next) => childAuth((await getDeps()).auth)(c, next));

  r.get('/', async (c) => {
    const deps = await getDeps();
    const { base } = await childOwner(deps, c.get('child').childId);
    const items: FollowupsRes['items'] = [];
    const now = new Date();
    for (const kind of ['consultation', 'crisis'] as const) {
      const collection = kind === 'crisis' ? 'crisisEvents' : 'consultations';
      const dateField = kind === 'crisis' ? 'createdAt' : 'offeredAt';
      const snap = await deps.db
        .collection(`${base}/${collection}`)
        .orderBy(dateField, 'desc')
        .limit(limits.pageSize.max)
        .get();
      for (const doc of snap.docs) {
        const due = followupDue(kind, doc.data());
        if (!due || due > now) continue;
        items.push({
          followupId: `${kind}-${doc.id}${doc.get('followUpRound') ? `~${doc.get('followUpRound')}` : ''}`,
          kind,
          dueAt: due.toISOString(),
          ...(kind === 'crisis' ? { crisisId: doc.id } : { consultationId: doc.id }),
        });
      }
    }
    items.sort((a, b) => a.dueAt.localeCompare(b.dueAt));
    return c.json({ items } satisfies FollowupsRes);
  });

  r.post('/:id/answer', async (c) => {
    const parsed = z
      .strictObject({ answer: z.enum(['talked', 'need_help', 'not_now', 'supported']) })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ApiHttpError('INVALID_ARGUMENT', '回答の形式が正しくありません');
    const id = c.req.param('id');
    const match = /^(consultation|crisis)-([a-zA-Z0-9_-]+)(?:~([1-9][0-9]*))?$/.exec(id);
    if (!match) throw new ApiHttpError('INVALID_ARGUMENT', 'ID の形式が正しくありません');
    const kind = match[1] as Kind;
    const sourceId = resourceId(match[2]!);
    const round = Number(match[3] ?? 0);
    if (!Number.isSafeInteger(round) || round >= consultation.followUpMaxRounds)
      throw new ApiHttpError('INVALID_ARGUMENT', 'フォローの回数が正しくありません');
    const deps = await getDeps();
    const { child, base, ref: childRef } = await childOwner(deps, c.get('child').childId);
    const source = deps.db.doc(
      `${base}/${kind === 'crisis' ? 'crisisEvents' : 'consultations'}/${sourceId}`,
    );
    const receipt = deps.db.doc(`${base}/followups/${id}`);
    const next = deps.db.doc(`${base}/consultations/follow-${stableId(child.childId, id)}`);
    const result = await deps.db.runTransaction(async (tx): Promise<FollowupAnswerRes> => {
      const owner = await tx.get(childRef);
      const previous = await tx.get(receipt);
      const snap = await tx.get(source);
      if (owner.get('status') !== 'active')
        throw new ApiHttpError('PERMISSION_DENIED', '利用できません');
      if (previous.exists) {
        if (previous.get('answer') !== parsed.data.answer)
          throw new ApiHttpError('ALREADY_EXISTS', '回答済みです');
        return (
          (previous.get('result') as FollowupAnswerRes | undefined) ?? {
            status: 'answered',
            ...(previous.get('consultationId')
              ? { consultationId: previous.get('consultationId') as string }
              : {}),
          }
        );
      }
      if (!snap.exists) throw new ApiHttpError('NOT_FOUND', 'フォローが見つかりません');
      if (Number(snap.get('followUpRound') ?? 0) !== round)
        throw new ApiHttpError('ALREADY_EXISTS', '新しいフォローを開いてください');
      const due = followupDue(kind, snap.data()!);
      if (!due || due > new Date())
        throw new ApiHttpError('INVALID_ARGUMENT', '今は回答できません');
      const consultationId = parsed.data.answer === 'need_help' ? next.id : undefined;
      const now = new Date();
      const schedule =
        ['talked', 'not_now'].includes(parsed.data.answer) &&
        round + 1 < consultation.followUpMaxRounds;
      const nextAt = new Date(now.getTime() + consultation.l2FollowUpDays * 86_400_000);
      const continuation = consultationId
        ? 'help_requested'
        : parsed.data.answer === 'supported'
          ? 'supported'
          : schedule
            ? 'scheduled'
            : 'paused';
      const response: FollowupAnswerRes = {
        status: 'answered',
        continuation,
        ...(consultationId ? { consultationId } : {}),
        ...(schedule ? { dueAt: nextAt.toISOString() } : {}),
      };
      if (consultationId)
        tx.create(next, {
          assessmentId: 'child-followup',
          level: 'l2',
          source: 'child_followup',
          offeredAt: now,
          offerCount: 1,
          previousFollowupId: id,
          followUpReason: 'need_help',
          familyHarmSuspected: snap.get('familyHarmSuspected') === true,
        });
      tx.create(receipt, {
        kind,
        sourceId,
        answer: parsed.data.answer,
        answeredAt: now,
        result: response,
        ...(consultationId ? { consultationId } : {}),
      });
      tx.update(source, {
        followUpAnswer: parsed.data.answer,
        followUpState: consultationId
          ? 'needs_help'
          : schedule
            ? parsed.data.answer === 'talked'
              ? 'talked'
              : 'later'
            : continuation,
        followUpUpdatedAt: now,
        followUpRound: round + 1,
        followUpAnsweredAt: schedule ? FieldValue.delete() : now,
        followUpAt: schedule ? nextAt : FieldValue.delete(),
      });
      // A child's follow-up answer is not evidence that a crisis has been professionally resolved.
      return response;
    });
    return c.json(result);
  });
}
