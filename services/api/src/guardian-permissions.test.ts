import { randomUUID } from 'node:crypto';

import { Firestore } from '@google-cloud/firestore';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createApp } from './app.js';
import { familyOfGuardian } from './routes/notifications.js';

let db: Firestore;
let app: ReturnType<typeof createApp>;
const SUMMARY = 'APPROVED_CHILD_SUMMARY_FIXTURE';
beforeAll(() => {
  if (!process.env['FIRESTORE_EMULATOR_HOST']) throw new Error('needs Firestore emulator');
  db = new Firestore({ projectId: `demo-guardian-permissions-${Date.now()}` });
  app = createApp({
    getKb: async () => {
      throw new Error('unused');
    },
    allowedOrigins: [],
    guardian: async () => ({ db, auth: { allowDevHeader: true } }),
    guardianDeletion: async () => ({
      db,
      auth: { allowDevHeader: true },
      publish: vi.fn(async () => {}),
    }),
  });
});
afterAll(() => db.terminate());

async function seed(membership: Record<string, unknown> = { role: 'primary' }) {
  const suffix = randomUUID().replaceAll('-', '');
  const familyId = `f_${suffix}`;
  const guardianId = `g_${suffix}`;
  const childId = `c_${suffix}`;
  const root = db.doc(`families/${familyId}`);
  const member = root.collection('guardians').doc(guardianId);
  const child = root.collection('children').doc(childId);
  const notification = root.collection('notifications').doc('n1');
  const crisis = child.collection('crisisEvents').doc('k1');
  await root.set({ status: 'active' });
  await member.set({ guardianId, ...membership });
  await child.set({ childId, familyId, status: 'active' });
  await crisis.set({
    status: 'open',
    familyHarmSuspected: false,
    notificationId: 'n1',
    timeline: [],
  });
  await notification.set({
    childId,
    recipientIds: [guardianId],
    kind: 'crisis',
    status: 'queued',
    payload: { title: 'Synthetic notice', childSummary: SUMMARY },
    createdAt: new Date(),
  });
  return {
    familyId,
    guardianId,
    childId,
    child,
    member,
    notification,
    crisis,
    headers: { 'X-Dev-Guardian-Id': guardianId },
  };
}

describe('guardian membership authorization', () => {
  it.each([
    ['revoked', { role: 'primary', revokedAt: new Date() }],
    ['paused', { role: 'secondary', status: 'paused' }],
    ['deleted', { role: 'primary', status: 'deleted' }],
    ['invalid-status', { role: 'primary', status: null }],
    ['invalid-role', { role: 'viewer' }],
    ['missing-role', {}],
  ])(
    'denies %s memberships in the shared resolver and notification operations',
    async (_name, membership) => {
      const f = await seed(membership);
      await expect(familyOfGuardian(db, f.guardianId)).rejects.toMatchObject({
        code: 'PERMISSION_DENIED',
      });
      for (const [url, method] of [
        ['/v1/notifications', 'GET'],
        ['/v1/notifications/n1', 'GET'],
        ['/v1/notifications/n1/ack', 'POST'],
        ['/v1/context-events', 'GET'],
      ] as const) {
        const response = await app.request(url, { method, headers: f.headers });
        expect.soft(response.status).toBe(403);
        expect.soft(await response.text()).not.toContain(SUMMARY);
      }
      expect((await f.notification.get()).get('acknowledgedAt')).toBeUndefined();
      expect((await f.crisis.get()).get('status')).toBe('open');
    },
  );

  it.each(['primary', 'secondary'])(
    'allows active %s memberships and absent legacy status',
    async (role) => {
      const f = await seed({
        role,
        revokedAt: null,
        ...(role === 'primary' ? { status: 'active' } : {}),
      });
      expect(await familyOfGuardian(db, f.guardianId)).toBe(f.familyId);
      const list = await app.request('/v1/notifications', { headers: f.headers });
      expect(list.status).toBe(200);
      expect(await list.json()).toMatchObject({ items: [{ id: 'n1' }] });
      const detail = await app.request('/v1/notifications/n1', { headers: f.headers });
      expect(detail.status).toBe(200);
      expect(await detail.json()).toMatchObject({ childSummary: SUMMARY });
      expect(
        (await app.request('/v1/notifications/n1/ack', { method: 'POST', headers: f.headers }))
          .status,
      ).toBe(200);
    },
  );

  it('lets an authenticated guardian request deletion only for a child in the same family', async () => {
    const f = await seed({ role: 'primary', status: 'active' });
    const response = await app.request(`/v1/children/${f.childId}/data-deletion-requests`, {
      method: 'POST',
      headers: f.headers,
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ status: 'accepted' });
    expect((await f.child.get()).get('status')).toBe('deleting');
  });

  it.each([
    ['list', '/v1/notifications', 'GET', 1],
    ['detail', '/v1/notifications/n1', 'GET', 1],
    ['ack-load', '/v1/notifications/n1/ack', 'POST', 1],
    ['ack-write', '/v1/notifications/n1/ack', 'POST', 2],
  ] as const)(
    'rechecks revocation inside the %s transaction after authentication',
    async (_name, url, method, revokeAt) => {
      const f = await seed();
      const run = db.runTransaction.bind(db);
      let transactions = 0;
      const spy = vi.spyOn(db, 'runTransaction').mockImplementation(async (handler, options) => {
        if (++transactions === revokeAt) await f.member.update({ revokedAt: new Date() });
        return run(handler, options);
      });
      try {
        const response = await app.request(url, { method, headers: f.headers });
        expect(response.status).toBe(403);
        expect(await response.text()).not.toContain(SUMMARY);
        expect(transactions).toBe(revokeAt);
        expect((await f.notification.get()).get('acknowledgedAt')).toBeUndefined();
        expect((await f.crisis.get()).get('status')).toBe('open');
      } finally {
        spy.mockRestore();
      }
    },
  );
});
