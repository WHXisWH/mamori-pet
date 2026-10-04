import { Firestore } from '@google-cloud/firestore';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from './app.js';

let db: Firestore;
let app: ReturnType<typeof createApp>;
const headers = { 'X-Dev-Guardian-Id': 'g_weekly' };
const base = 'families/f_weekly/children/c_weekly';
const vitality = {
  mood: { sunny: 2, cloudy: 1, rainy: 0, stormy: 0 },
  activeDays: 4,
  lateNightDays: 1,
};

beforeAll(async () => {
  if (!process.env['FIRESTORE_EMULATOR_HOST']) throw new Error('needs Firestore emulator');
  db = new Firestore({ projectId: `demo-guardian-weekly-${Date.now()}` });
  await db.doc('families/f_weekly').set({ status: 'active' });
  await db
    .doc('families/f_weekly/guardians/g_weekly')
    .set({ guardianId: 'g_weekly', role: 'primary' });
  await db
    .doc('families/f_other/guardians/g_other')
    .set({ guardianId: 'g_other', role: 'primary' });
  await db.doc(base).set({ status: 'active' });
  await db.doc(`${base}/weeklyReports/2026-W39`).set({
    weekStart: '2026-09-21',
    vitality,
    summaryText: '今週の記録です。',
    level: 'l3',
    transcript: 'PRIVATE_CHILD_TEXT',
    artworkInterpretation: 'PRIVATE_ARTWORK',
  });
  await db
    .doc(`${base}/weeklyReports/2026-W38`)
    .set({ weekStart: '2026-09-14', vitality, summaryText: '前の週の記録です。' });
  app = createApp({
    getKb: async () => {
      throw new Error('unused');
    },
    allowedOrigins: [],
    guardian: async () => ({ db, auth: { allowDevHeader: true } }),
  });
});
afterAll(() => db.terminate());

describe('guardian weekly projection', () => {
  it.each([
    ['revoked', { role: 'primary', revokedAt: new Date() }],
    ['paused', { role: 'secondary', status: 'paused' }],
    ['invalid-role', { role: 'child' }],
    ['missing-role', {}],
  ])('does not expose reports to a %s guardian', async (name, membership) => {
    const guardianId = `g_denied_${name}`;
    await db.doc(`families/f_weekly/guardians/${guardianId}`).set({ guardianId, ...membership });
    const response = await app.request('/v1/children/c_weekly/weekly-reports', {
      headers: { 'X-Dev-Guardian-Id': guardianId },
    });
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain('summaryText');
  });
  it('returns the latest stored report with an explicit data-minimized projection', async () => {
    const res = await app.request('/v1/children/c_weekly/weekly-reports', { headers });
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({
      weekId: '2026-W39',
      vitality,
      summaryText: '今週の記録です。',
    });
  });
  it('reads a requested week and distinguishes missing reports from zero activity', async () => {
    const res = await app.request('/v1/children/c_weekly/weekly-reports?week=2026-W38', {
      headers,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ weekId: '2026-W38' });
    expect(
      (await app.request('/v1/children/c_weekly/weekly-reports?week=2026-W37', { headers })).status,
    ).toBe(404);
  });
  it('requires guardian authentication and rejects foreign children', async () => {
    expect((await app.request('/v1/children/c_weekly/weekly-reports')).status).toBe(401);
    expect(
      (
        await app.request('/v1/children/c_weekly/weekly-reports', {
          headers: { 'X-Dev-Guardian-Id': 'g_other' },
        })
      ).status,
    ).toBe(404);
    expect((await app.request('/v1/children/unknown/weekly-reports', { headers })).status).toBe(
      404,
    );
  });
  it.each(['2026-W00', '2026-W54', '../private', 'not-a-week'])(
    'rejects invalid week %s',
    async (week) => {
      expect(
        (
          await app.request(
            `/v1/children/c_weekly/weekly-reports?week=${encodeURIComponent(week)}`,
            { headers },
          )
        ).status,
      ).toBe(400);
    },
  );
  it('does not expose reports after the child is paused or deleted', async () => {
    await db.doc('families/f_weekly/children/c_paused').set({ status: 'paused' });
    await db
      .doc('families/f_weekly/children/c_paused/weeklyReports/2026-W39')
      .set({ weekStart: '2026-09-21', vitality, summaryText: 'PRIVATE' });
    expect((await app.request('/v1/children/c_paused/weekly-reports', { headers })).status).toBe(
      404,
    );
    await db.doc('families/f_weekly/children/c_paused').delete();
    expect((await app.request('/v1/children/c_paused/weekly-reports', { headers })).status).toBe(
      404,
    );
  });
  it('does not turn malformed stored data into fabricated zeroes', async () => {
    await db.doc(`${base}/weeklyReports/2026-W36`).set({
      weekStart: '2026-08-31',
      vitality: { activeDays: 'PRIVATE' },
      summaryText: 'invalid',
    });
    const res = await app.request('/v1/children/c_weekly/weekly-reports?week=2026-W36', {
      headers,
    });
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('PRIVATE');
  });
  it.each(['open', 'guardian_acknowledged', 'unknown'])(
    'suppresses new trend reads during a %s family-harm or unknown-family crisis',
    async (status) => {
      const child = `c_suppressed_${status}`;
      const root = db.doc(`families/f_weekly/children/${child}`);
      await root.set({ status: 'active' });
      await root
        .collection('weeklyReports')
        .doc('2026-W39')
        .set({ weekStart: '2026-09-21', vitality, summaryText: 'PRIVATE_TREND' });
      const crisis = root.collection('crisisEvents').doc('k1');
      await crisis.set({ status });
      const url = `/v1/children/${child}/weekly-reports`;
      expect((await app.request(url, { headers })).status).toBe(404);
      await crisis.update({ familyHarmSuspected: true });
      expect((await app.request(url, { headers })).status).toBe(404);
      await crisis.update({ status: 'closed' });
      expect((await app.request(url, { headers })).status).toBe(200);
    },
  );
  it.each(['paused', 'deleting', 'consent_revoked'])(
    'rejects reports for an unavailable family: %s',
    async (state) => {
      const family = `f_blocked_${state}`;
      const guardian = `g_blocked_${state}`;
      await db.doc(`families/${family}`).set({
        status: state === 'consent_revoked' ? 'active' : state,
        consentComplete: state !== 'consent_revoked',
      });
      await db
        .doc(`families/${family}/guardians/${guardian}`)
        .set({ guardianId: guardian, role: 'primary' });
      await db.doc(`families/${family}/children/c1`).set({ status: 'active' });
      await db
        .doc(`families/${family}/children/c1/weeklyReports/2026-W39`)
        .set({ weekStart: '2026-09-21', vitality, summaryText: 'PRIVATE_FAMILY' });
      const res = await app.request('/v1/children/c1/weekly-reports', {
        headers: { 'X-Dev-Guardian-Id': guardian },
      });
      expect(res.status).toBe(403);
      expect(await res.text()).not.toContain('PRIVATE_FAMILY');
    },
  );
});
