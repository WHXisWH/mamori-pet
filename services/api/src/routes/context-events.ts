import { randomUUID } from 'node:crypto';

import type { Firestore } from '@google-cloud/firestore';
import {
  CONTEXT_CATEGORIES,
  type ContextEvent,
  type CreateContextEventReq,
  type Page,
} from '@ijime/api-types';
import { ApiHttpError, type ServiceApp, type ServiceEnv } from '@ijime/service-kit';
import type { Hono } from 'hono';
import { z } from 'zod';

import { guardianAuth, type GuardianAuthEnv } from '../auth.js';
import { familyOfGuardian, type NotificationRoutesDeps } from './notifications.js';

const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const createSchema = z
  .object({
    childIds: z.array(z.string().min(1)).min(1).max(10),
    category: z.enum(CONTEXT_CATEGORIES),
    startDate: localDate,
    endDate: localDate,
  })
  .refine((v) => v.startDate <= v.endDate);

type StoredContextEvent = Omit<ContextEvent, 'eventId'> & { createdBy: string };

const toEvent = (eventId: string, d: StoredContextEvent): ContextEvent => ({
  eventId,
  childIds: d.childIds,
  category: d.category,
  startDate: d.startDate,
  endDate: d.endDate,
  source: d.source,
});

async function assertChildren(db: Firestore, familyId: string, childIds: string[]) {
  const snaps = await db.getAll(
    ...childIds.map((id) => db.doc(`families/${familyId}/children/${id}`)),
  );
  if (snaps.some((s) => !s.exists)) throw new ApiHttpError('NOT_FOUND', 'お子さんが見つかりません');
}

export function registerContextEvents(
  app: ServiceApp,
  getDeps: () => Promise<NotificationRoutesDeps>,
): void {
  const r = (app as unknown as Hono<GuardianAuthEnv & ServiceEnv>).basePath('/v1/context-events');
  r.use('*', async (c, next) => {
    const deps = await getDeps();
    return guardianAuth(deps.auth, (g) => familyOfGuardian(deps.db, g))(c, next);
  });

  r.get('/', async (c) => {
    const { db } = await getDeps();
    const { familyId } = c.get('guardian');
    const childId = c.req.query('childId');
    if (!childId) throw new ApiHttpError('INVALID_ARGUMENT', 'childId が必要です');
    await assertChildren(db, familyId, [childId]);
    const snap = await db
      .collection(`families/${familyId}/contextEvents`)
      .where('childIds', 'array-contains', childId)
      .orderBy('startDate', 'asc')
      .get();
    const body: Page<ContextEvent> = {
      items: snap.docs.map((d) => toEvent(d.id, d.data() as StoredContextEvent)),
    };
    return c.json(body);
  });

  r.post('/', async (c) => {
    const { db } = await getDeps();
    const { familyId, guardianId } = c.get('guardian');
    const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ApiHttpError('INVALID_ARGUMENT', '入力内容を確認してください');
    const req: CreateContextEventReq = {
      ...parsed.data,
      childIds: [...new Set(parsed.data.childIds)],
    };
    await assertChildren(db, familyId, req.childIds);
    const eventId = `ctx_${randomUUID()}`;
    const doc: StoredContextEvent = { ...req, source: 'manual', createdBy: guardianId };
    await db.doc(`families/${familyId}/contextEvents/${eventId}`).set(doc);
    return c.json(toEvent(eventId, doc), 201);
  });

  r.delete('/:eventId', async (c) => {
    const { db } = await getDeps();
    const { familyId } = c.get('guardian');
    const ref = db.doc(`families/${familyId}/contextEvents/${c.req.param('eventId')}`);
    const d = (await ref.get()).data() as StoredContextEvent | undefined;
    if (!d) throw new ApiHttpError('NOT_FOUND', '予定が見つかりません');
    // カレンダー由来のコンテキスト情報は次回の同期でまた現れるため、Google カレンダー側でしか変更できない
    if (d.source !== 'manual')
      throw new ApiHttpError(
        'INVALID_ARGUMENT',
        'カレンダーから取り込んだ予定は Google カレンダーで変更してください',
      );
    await ref.delete();
    return c.body(null, 204);
  });
}
