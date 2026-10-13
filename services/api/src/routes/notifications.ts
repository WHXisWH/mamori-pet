import {
  FieldValue,
  type DocumentSnapshot,
  type Firestore,
  type Transaction,
} from '@google-cloud/firestore';
import type {
  AckRes,
  HelpResource,
  NotificationDetail,
  NotificationKind,
  NotificationsRes,
  NotificationSummary,
  NotificationFeedbackRes,
} from '@ijime/api-types';
import { ACTIVE_CRISIS_STATUSES, isCrisisActive, limits } from '@ijime/config';
import { ApiHttpError, type ServiceApp, type ServiceEnv } from '@ijime/service-kit';
import type { Hono } from 'hono';
import { z } from 'zod';

import { guardianAuth, type AuthOptions, type GuardianAuthEnv } from '../auth.js';
import { resourceId } from './workflow-store.js';

export type NotificationRoutesDeps = { db: Firestore; auth: AuthOptions };

type StoredNotification = {
  childId: string;
  recipientIds: string[];
  kind: NotificationKind;
  payload: {
    title: string;
    changes?: string[];
    meaning?: string;
    suggestions?: { try: string[]; avoid: string[] };
    childSummary?: string | null;
    resources?: HelpResource[];
    reason?: { domains: string[]; days: number };
  };
  acknowledgedAt?: { toDate(): Date };
  feedback?: { action: 'talked' | 'planned' | 'need_help'; updatedAt: { toDate(): Date } };
  createdAt: { toDate(): Date };
};

function assertGuardianMembership(member: DocumentSnapshot, guardianId: string): void {
  const role = member.get('role');
  const status = member.get('status');
  if (
    !member.exists ||
    member.id !== guardianId ||
    member.get('guardianId') !== guardianId ||
    (role !== 'primary' && role !== 'secondary') ||
    member.get('revokedAt') != null ||
    (status !== undefined && status !== 'active')
  )
    throw new ApiHttpError('PERMISSION_DENIED', '保護者の情報を利用できません');
}

async function recheckGuardian(
  tx: Transaction,
  db: Firestore,
  familyId: string,
  guardianId: string,
) {
  const member = await tx.get(db.doc(`families/${familyId}/guardians/${guardianId}`));
  assertGuardianMembership(member, guardianId);
}

export async function familyOfGuardian(db: Firestore, guardianId: string) {
  const snap = await db
    .collectionGroup('guardians')
    .where('guardianId', '==', guardianId)
    .limit(1)
    .get();
  const member = snap.docs[0];
  if (!member) return undefined;
  assertGuardianMembership(member, guardianId);
  return member.ref.parent.parent?.id;
}

// 保護者に見せてよいフィールドだけを選ぶ：レベル、原文、作品の解釈は含めない
function summary(id: string, n: StoredNotification): NotificationSummary {
  const out: NotificationSummary = {
    id,
    childId: n.childId,
    kind: n.kind,
    title: n.payload.title,
    createdAt: n.createdAt.toDate().toISOString(),
  };
  if (n.acknowledgedAt) out.acknowledgedAt = n.acknowledgedAt.toDate().toISOString();
  return out;
}

// 入れ子のオブジェクトもフィールドを1つずつ選ぶ。保存データにある余分なフィールドをそのまま保護者に渡してはならない
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];

function resource(r: HelpResource): HelpResource {
  return {
    id: r.id,
    name: r.name,
    audience: r.audience,
    ...(r.phone !== undefined ? { phone: r.phone } : {}),
    ...(r.url !== undefined ? { url: r.url } : {}),
    ...(r.hours !== undefined ? { hours: r.hours } : {}),
  };
}

function detail(id: string, n: StoredNotification): NotificationDetail {
  const { suggestions, reason } = n.payload;
  return {
    ...summary(id, n),
    changes: strings(n.payload.changes),
    meaning: n.payload.meaning ?? '',
    suggestions: { try: strings(suggestions?.try), avoid: strings(suggestions?.avoid) },
    childSummary: n.payload.childSummary ?? null,
    resources: (n.payload.resources ?? []).map(resource),
    reason: { domains: strings(reason?.domains), days: reason?.days ?? 0 },
    ...(n.feedback
      ? {
          feedback: {
            action: n.feedback.action,
            updatedAt: n.feedback.updatedAt.toDate().toISOString(),
          },
        }
      : {}),
  };
}

async function canReadChildNotifications(
  tx: Transaction,
  db: Firestore,
  familyId: string,
  childId: string,
): Promise<boolean> {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(childId)) return false;
  const base = `families/${familyId}/children/${childId}`;
  const child = await tx.get(db.doc(base));
  if (child.get('status') !== 'active') return false;
  const active = await tx.get(
    db.collection(`${base}/crisisEvents`).where('status', 'in', ACTIVE_CRISIS_STATUSES),
  );
  const now = new Date();
  return !active.docs.some(
    (d) => isCrisisActive(d.data(), now) && d.get('familyHarmSuspected') !== false,
  );
}

export function registerNotifications(
  app: ServiceApp,
  getDeps: () => Promise<NotificationRoutesDeps>,
): void {
  const r = (app as unknown as Hono<GuardianAuthEnv & ServiceEnv>).basePath('/v1/notifications');
  r.use('*', async (c, next) => {
    const deps = await getDeps();
    c.header('Cache-Control', 'no-store');
    return guardianAuth(deps.auth, (g) => familyOfGuardian(deps.db, g))(c, next);
  });

  const load = async (db: Firestore, familyId: string, guardianId: string, id: string) => {
    return db.runTransaction(
      async (tx) => {
        await recheckGuardian(tx, db, familyId, guardianId);
        const snap = await tx.get(db.doc(`families/${familyId}/notifications/${resourceId(id)}`));
        const n = snap.data() as StoredNotification | undefined;
        if (
          !n ||
          !n.recipientIds.includes(guardianId) ||
          !(await canReadChildNotifications(tx, db, familyId, n.childId))
        )
          throw new ApiHttpError('NOT_FOUND', 'お知らせが見つかりません');
        return { snap, n };
      },
      { readOnly: true },
    );
  };

  r.get('/', async (c) => {
    const { db } = await getDeps();
    const { familyId, guardianId } = c.get('guardian');
    const onlyUnacked = c.req.query('status') === 'unacknowledged';
    const size = Math.min(
      Number(c.req.query('pageSize') ?? limits.pageSize.default) || limits.pageSize.default,
      limits.pageSize.max,
    );
    if (!Number.isInteger(size) || size < 1)
      throw new ApiHttpError('INVALID_ARGUMENT', 'ページサイズが正しくありません');
    const col = db.collection(`families/${familyId}/notifications`);
    let q = col
      .where('recipientIds', 'array-contains', guardianId)
      .orderBy('createdAt', 'desc')
      .limit(size);
    const token = c.req.query('pageToken');
    if (token) {
      const cursor: DocumentSnapshot = await col.doc(resourceId(token)).get();
      if (cursor.exists) q = q.startAfter(cursor);
    }
    const body = await db.runTransaction(
      async (tx): Promise<NotificationsRes> => {
        await recheckGuardian(tx, db, familyId, guardianId);
        const snap = await tx.get(q);
        const allowed = new Map<string, boolean>();
        const items: NotificationSummary[] = [];
        for (const doc of snap.docs) {
          const n = doc.data() as StoredNotification;
          if (!allowed.has(n.childId))
            allowed.set(n.childId, await canReadChildNotifications(tx, db, familyId, n.childId));
          if (!allowed.get(n.childId) || (onlyUnacked && n.acknowledgedAt)) continue;
          items.push(summary(doc.id, n));
        }
        return {
          items,
          ...(snap.size === size ? { nextPageToken: snap.docs[snap.size - 1]!.id } : {}),
        };
      },
      { readOnly: true },
    );
    return c.json(body);
  });

  r.get('/:notificationId', async (c) => {
    const { db } = await getDeps();
    const { familyId, guardianId } = c.get('guardian');
    const { n } = await load(db, familyId, guardianId, c.req.param('notificationId'));
    return c.json(detail(c.req.param('notificationId'), n));
  });

  r.put('/:notificationId/feedback', async (c) => {
    const parsed = z
      .strictObject({ action: z.enum(['talked', 'planned', 'need_help']) })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ApiHttpError('INVALID_ARGUMENT', '回答の形式が正しくありません');
    const { db } = await getDeps();
    const { familyId, guardianId } = c.get('guardian');
    const { snap } = await load(db, familyId, guardianId, c.req.param('notificationId'));
    const feedback = await db.runTransaction(async (tx) => {
      await recheckGuardian(tx, db, familyId, guardianId);
      const n = (await tx.get(snap.ref)).data() as StoredNotification | undefined;
      if (
        !n ||
        !n.recipientIds.includes(guardianId) ||
        !(await canReadChildNotifications(tx, db, familyId, n.childId))
      )
        throw new ApiHttpError('NOT_FOUND', 'お知らせが見つかりません');
      const value = { action: parsed.data.action, updatedAt: new Date() };
      // Adult self-report is neither acknowledgement nor evidence of a resolved incident.
      tx.update(snap.ref, { feedback: value });
      return { action: value.action, updatedAt: value.updatedAt.toISOString() };
    });
    return c.json({ feedback } satisfies NotificationFeedbackRes);
  });

  r.post('/:notificationId/ack', async (c) => {
    const { db } = await getDeps();
    const { familyId, guardianId } = c.get('guardian');
    const id = c.req.param('notificationId');
    const { snap } = await load(db, familyId, guardianId, id);
    const at = await db.runTransaction(async (tx) => {
      await recheckGuardian(tx, db, familyId, guardianId);
      const cur = (await tx.get(snap.ref)).data() as StoredNotification;
      if (
        !cur ||
        !cur.recipientIds.includes(guardianId) ||
        !(await canReadChildNotifications(tx, db, familyId, cur.childId))
      )
        throw new ApiHttpError('NOT_FOUND', 'お知らせが見つかりません');
      if (cur.acknowledgedAt) return cur.acknowledgedAt.toDate();
      const crisis =
        cur.kind === 'crisis'
          ? (
              await tx.get(
                db
                  .collection(`families/${familyId}/children/${cur.childId}/crisisEvents`)
                  .where('notificationId', '==', id)
                  .limit(1),
              )
            ).docs[0]
          : undefined;
      const now = new Date();
      tx.update(snap.ref, {
        acknowledgedAt: now,
        acknowledgedBy: guardianId,
        status: 'acknowledged',
      });
      if (crisis)
        tx.update(crisis.ref, {
          status: 'guardian_acknowledged',
          timeline: FieldValue.arrayUnion({ step: 'guardian_acknowledged', at: now }),
        });
      return now;
    });
    const body: AckRes = { acknowledgedAt: at.toISOString() };
    return c.json(body);
  });
}
