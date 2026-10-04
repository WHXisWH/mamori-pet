import { Firestore } from '@google-cloud/firestore';
import type { AckRes, NotificationDetail, NotificationsRes } from '@ijime/api-types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from './app.js';

let db: Firestore;
let app: ReturnType<typeof createApp>;
const F = 'f_notif';
const C = 'c_notif';
const H = (g: string) => ({ 'Content-Type': 'application/json', 'X-Dev-Guardian-Id': g });

beforeAll(async () => {
  if (!process.env['FIRESTORE_EMULATOR_HOST']) throw new Error('needs Firestore emulator');
  db = new Firestore({ projectId: 'demo-ijime' });
  await db.doc(`families/${F}/children/${C}`).set({ childId: C, familyId: F, status: 'active' });
  await db.doc(`families/${F}/guardians/g_n1`).set({ guardianId: 'g_n1', role: 'primary' });
  await db.doc(`families/${F}/guardians/g_n2`).set({ guardianId: 'g_n2', role: 'secondary' });
  await db.doc(`families/f_other/guardians/g_x`).set({ guardianId: 'g_x', role: 'primary' });
  await db.doc(`families/${F}/notifications/n1`).set({
    childId: C,
    recipientIds: ['g_n1', 'g_n2'],
    kind: 'crisis',
    level: 'l4',
    templateId: 'templates/notifications/crisis.ja.md@0.1.0',
    payload: {
      title: '今すぐはなさんのそばにいてください',
      changes: [],
      meaning: 'm',
      suggestions: { try: ['a'], avoid: [] },
      childSummary: null,
      resources: [{ id: 'emergency', name: '警察・救急', audience: 'x' }],
      reason: { domains: [], days: 0 },
    },
    channels: ['webpush'],
    status: 'sent',
    attempts: [
      { guardianId: 'g_n1', channel: 'webpush', round: 0, at: new Date(), result: 'sent' },
    ],
    createdAt: new Date('2026-10-01T09:00:00Z'),
  });
  await db.doc(`families/${F}/children/${C}/crisisEvents/k1`).set({
    notificationId: 'n1',
    status: 'open',
    familyHarmSuspected: false,
    timeline: [],
  });
  app = createApp({
    getKb: async () => {
      throw new Error('unused');
    },
    allowedOrigins: [],
    guardian: async () => ({ db, auth: { allowDevHeader: true } }),
  });
});

afterAll(() => db.terminate());

describe('guardian notifications API', () => {
  it('requires a guardian', async () => {
    expect((await app.request('/v1/notifications')).status).toBe(401);
    expect((await app.request('/v1/notifications', { headers: H('nobody') })).status).toBe(403);
  });

  it('lists and shows only the packaged content, never the level', async () => {
    const list = (await (
      await app.request('/v1/notifications?status=unacknowledged', { headers: H('g_n1') })
    ).json()) as NotificationsRes;
    expect(list.items).toEqual([
      {
        id: 'n1',
        childId: C,
        kind: 'crisis',
        title: '今すぐはなさんのそばにいてください',
        createdAt: '2026-10-01T09:00:00.000Z',
      },
    ]);
    const res = await app.request('/v1/notifications/n1', { headers: H('g_n1') });
    const detail = (await res.json()) as NotificationDetail & Record<string, unknown>;
    expect(detail.suggestions).toEqual({ try: ['a'], avoid: [] });
    for (const k of ['level', 'templateId', 'attempts', 'recipientIds', 'channels'])
      expect(detail).not.toHaveProperty(k);
  });

  it('hides notifications from other families', async () => {
    expect((await app.request('/v1/notifications/n1', { headers: H('g_x') })).status).toBe(404);
  });

  it('acknowledges once and closes the crisis escalation', async () => {
    const r1 = await app.request('/v1/notifications/n1/ack', {
      method: 'POST',
      headers: H('g_n2'),
    });
    expect(r1.status).toBe(200);
    const a1 = (await r1.json()) as AckRes;
    const r2 = await app.request('/v1/notifications/n1/ack', {
      method: 'POST',
      headers: H('g_n1'),
    });
    expect(((await r2.json()) as AckRes).acknowledgedAt).toBe(a1.acknowledgedAt);

    const n = (await db.doc(`families/${F}/notifications/n1`).get()).data()!;
    expect(n['acknowledgedBy']).toBe('g_n2');
    expect(n['status']).toBe('acknowledged');
    const k = (await db.doc(`families/${F}/children/${C}/crisisEvents/k1`).get()).data()!;
    expect(k['status']).toBe('guardian_acknowledged');
    expect((k['timeline'] as { step: string }[]).map((e) => e.step)).toEqual([
      'guardian_acknowledged',
    ]);

    const unacked = (await (
      await app.request('/v1/notifications?status=unacknowledged', { headers: H('g_n1') })
    ).json()) as NotificationsRes;
    expect(unacked.items).toEqual([]);
  });
});
