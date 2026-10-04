import { randomUUID } from 'node:crypto';

import { Firestore } from '@google-cloud/firestore';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from './app.js';

let db: Firestore;
let app: ReturnType<typeof createApp>;
const SUMMARY = '子どもが確認した要約';

beforeAll(() => {
  if (!process.env['FIRESTORE_EMULATOR_HOST']) throw new Error('needs Firestore emulator');
  db = new Firestore({ projectId: 'demo-ijime' });
  app = createApp({
    getKb: async () => {
      throw new Error('unused');
    },
    allowedOrigins: [],
    guardian: async () => ({ db, auth: { allowDevHeader: true } }),
  });
});
afterAll(async () => {
  await db?.terminate();
});

async function seed() {
  const id = randomUUID().replaceAll('-', '');
  const familyId = `f_nw_${id}`;
  const guardianId = `g_nw_${id}`;
  const childId = `c_nw_${id}`;
  const base = `families/${familyId}/children/${childId}`;
  await db.doc(`families/${familyId}/guardians/${guardianId}`).set({ guardianId, role: 'primary' });
  await db.doc(base).set({ childId, familyId, status: 'active' });
  await db.doc(`families/${familyId}/notifications/n1`).set({
    childId,
    recipientIds: [guardianId],
    kind: 'care_hint',
    level: 'l3',
    status: 'queued',
    payload: { title: '確認してください', changes: [], meaning: 'm', childSummary: SUMMARY },
    createdAt: new Date(),
  });
  return { familyId, guardianId, childId, base, headers: { 'X-Dev-Guardian-Id': guardianId } };
}

describe('guardian notification read safety', () => {
  it('returns approved content only while the child is active and family safety permits it', async () => {
    const o = await seed();
    await db.doc(`${o.base}/crisisEvents/safe`).set({ status: 'open', familyHarmSuspected: false });
    const res = await app.request('/v1/notifications/n1', { headers: o.headers });
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = await res.json();
    expect(body).toMatchObject({ childSummary: SUMMARY });
    expect(body).not.toHaveProperty('level');
  });

  it.each([
    ['open', true],
    ['open', undefined],
    ['guardian_acknowledged', true],
    ['guardian_acknowledged', undefined],
  ] as const)(
    'blocks new list/detail/ack reads after an unsafe %s crisis (%s)',
    async (status, familyHarmSuspected) => {
      const o = await seed();
      expect((await app.request('/v1/notifications/n1', { headers: o.headers })).status).toBe(200);
      await db
        .doc(`${o.base}/crisisEvents/unsafe`)
        .set({ status, ...(familyHarmSuspected === undefined ? {} : { familyHarmSuspected }) });
      const list = await app.request('/v1/notifications', { headers: o.headers });
      expect(await list.json()).toEqual({ items: [] });
      const detail = await app.request('/v1/notifications/n1', { headers: o.headers });
      expect(detail.status).toBe(404);
      expect(await detail.text()).not.toContain(SUMMARY);
      expect(
        (await app.request('/v1/notifications/n1/ack', { method: 'POST', headers: o.headers }))
          .status,
      ).toBe(404);
      expect(
        (await db.doc(`families/${o.familyId}/notifications/n1`).get()).get('acknowledgedAt'),
      ).toBeUndefined();
    },
  );

  it.each(['paused', 'deleting', 'missing'])(
    'hides data for a %s child even if an old notification remains',
    async (status) => {
      const o = await seed();
      if (status === 'missing') await db.doc(o.base).delete();
      else await db.doc(o.base).update({ status });
      expect(await (await app.request('/v1/notifications', { headers: o.headers })).json()).toEqual(
        { items: [] },
      );
      expect((await app.request('/v1/notifications/n1', { headers: o.headers })).status).toBe(404);
      expect(
        (await app.request('/v1/notifications/n1/ack', { method: 'POST', headers: o.headers }))
          .status,
      ).toBe(404);
    },
  );

  it('keeps another active child visible without disclosing the unsafe child', async () => {
    const o = await seed();
    await db
      .doc(`${o.base}/crisisEvents/unsafe`)
      .set({ status: 'open', familyHarmSuspected: true });
    await db
      .doc(`families/${o.familyId}/children/sibling`)
      .set({ childId: 'sibling', status: 'active' });
    await db.doc(`families/${o.familyId}/notifications/n2`).set({
      childId: 'sibling',
      recipientIds: [o.guardianId],
      kind: 'weekly_report',
      payload: { title: '今週の様子' },
      status: 'queued',
      createdAt: new Date(),
    });
    const result = (await (
      await app.request('/v1/notifications', { headers: o.headers })
    ).json()) as { items: { id: string }[] };
    expect(result.items.map((n) => n.id)).toEqual(['n2']);
  });
});
