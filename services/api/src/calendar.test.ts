import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Firestore } from '@google-cloud/firestore';
import type { CalendarConnectRes, CalendarsRes, ContextEvent, Page } from '@ijime/api-types';
import { runSync } from '@ijime/calendar-sync/src/sync.js';
import { TokenVault } from '@ijime/crypto';
import { FsKbSource, Kb } from '@ijime/kb-loader';
import { CALENDAR_SCOPES, Logger, MemoryCalendarApi } from '@ijime/service-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { signState, verifyState, type CalendarRoutesDeps } from './routes/calendar.js';

const KB_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../kb/v0.1.0');
const F = 'f_cal';
const G = 'g_cal';
const NOW = new Date('2026-11-20T01:00:00Z');
const SECRET = 'test-secret';
const ORIGIN = 'https://guardian.test';
const H = (g = G) => ({ 'Content-Type': 'application/json', 'X-Dev-Guardian-Id': g });

let db: Firestore;
let kb: Kb;
let app: ReturnType<typeof createApp>;
const api = new MemoryCalendarApi();
const vault = TokenVault.dev();
const logs: string[] = [];
let now = NOW;

beforeAll(async () => {
  if (!process.env['FIRESTORE_EMULATOR_HOST']) throw new Error('needs Firestore emulator');
  db = new Firestore({ projectId: `demo-calendar-${Date.now()}` });
  kb = await Kb.load(new FsKbSource(KB_DIR));
  await db.doc(`families/${F}/guardians/${G}`).set({ guardianId: G, role: 'primary' });
  await db
    .doc(`families/f_cal_other/guardians/g_other`)
    .set({ guardianId: 'g_other', role: 'primary' });
  await db
    .doc(`families/${F}/children/c_a`)
    .set({ childId: 'c_a', nickname: 'はな', status: 'active' });
  await db
    .doc(`families/${F}/children/c_b`)
    .set({ childId: 'c_b', nickname: 'ゆう', status: 'active' });
  const logger = new Logger('api', (l) => logs.push(l));
  const calendarDeps: CalendarRoutesDeps = {
    db,
    auth: { allowDevHeader: true },
    calendar: api,
    vault,
    stateSecret: SECRET,
    guardianWebOrigin: ORIGIN,
    logger,
    now: () => now,
  };
  app = createApp({
    getKb: async () => kb,
    allowedOrigins: [],
    guardian: async () => ({ db, auth: { allowDevHeader: true } }),
    calendar: async () => calendarDeps,
  });
});
afterAll(() => db.terminate());

const stateFrom = async () => {
  const res = await app.request('/v1/calendar/connect', { method: 'POST', headers: H() });
  expect(res.status).toBe(200);
  const { authUrl } = (await res.json()) as CalendarConnectRes;
  return new URL(authUrl).searchParams.get('state')!;
};

describe('OAuth state', () => {
  it('round-trips and rejects tampering, other secrets and expiry', () => {
    const s = signState(SECRET, { g: G, f: F, exp: NOW.getTime() + 60_000 });
    expect(verifyState(SECRET, s, NOW)).toMatchObject({ g: G, f: F });
    expect(verifyState('other', s, NOW)).toBeNull();
    expect(verifyState(SECRET, s, new Date(NOW.getTime() + 61_000))).toBeNull();
    const [body, sig] = s.split('.');
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(body!, 'base64url').toString()), g: 'g_x' }),
    ).toString('base64url');
    expect(verifyState(SECRET, `${forged}.${sig}`, NOW)).toBeNull();
    expect(verifyState(SECRET, 'garbage', NOW)).toBeNull();
  });
});

describe('calendar connection (S6)', () => {
  it('requires a guardian except on the callback', async () => {
    expect((await app.request('/v1/calendar/connect', { method: 'POST' })).status).toBe(401);
    expect((await app.request('/v1/calendar/calendars')).status).toBe(401);
    const cb = await app.request('/v1/calendar/callback?code=x&state=bad');
    expect(cb.status).toBe(302);
    expect(cb.headers.get('location')).toBe(`${ORIGIN}/context?calendar=error`);
  });

  it('rejects a grant missing a scope and revokes it', async () => {
    api.codes.set('partial', { refreshToken: 'rt_partial', scopes: [CALENDAR_SCOPES[0]] });
    const state = await stateFrom();
    const res = await app.request(`/v1/calendar/callback?code=partial&state=${state}`);
    expect(res.headers.get('location')).toBe(`${ORIGIN}/context?calendar=scope_denied`);
    expect(api.revoked).toContain('rt_partial');
    expect((await db.doc(`families/${F}/calendarConnections/${G}`).get()).exists).toBe(false);
  });

  it('rejects an expired state', async () => {
    api.codes.set('late', { refreshToken: 'rt_late', scopes: [...CALENDAR_SCOPES] });
    const state = await stateFrom();
    now = new Date(NOW.getTime() + 11 * 60_000);
    const res = await app.request(`/v1/calendar/callback?code=late&state=${state}`);
    now = NOW;
    expect(res.headers.get('location')).toBe(`${ORIGIN}/context?calendar=error`);
  });

  it('connects, selects calendars, syncs and lists context events', async () => {
    api.codes.set('good', { refreshToken: 'rt_good', scopes: [...CALENDAR_SCOPES] });
    api.accounts.set('rt_good', {
      calendars: [
        { id: 'me@example.com', summary: 'わたし', primary: true },
        { id: 'school@group', summary: '学校' },
      ],
      events: {
        'school@group': [
          {
            id: 'x1',
            summary: 'はな 期末テスト',
            start: { date: '2026-11-25' },
            end: { date: '2026-11-27' },
          },
          {
            id: 'x2',
            summary: '運動会',
            start: { date: '2026-11-28' },
            end: { date: '2026-11-29' },
          },
        ],
      },
    });
    const state = await stateFrom();
    const cb = await app.request(`/v1/calendar/callback?code=good&state=${state}`);
    expect(cb.headers.get('location')).toBe(`${ORIGIN}/context?calendar=connected`);
    const conn = (await db.doc(`families/${F}/calendarConnections/${G}`).get()).data()!;
    expect(conn).toMatchObject({
      calendarIds: ['primary'],
      status: 'active',
      scopes: [...CALENDAR_SCOPES],
    });
    expect(Buffer.from(conn['refreshTokenEnc']).toString('utf8')).not.toContain('rt_good');

    const list = (await (
      await app.request('/v1/calendar/calendars', { headers: H() })
    ).json()) as CalendarsRes;
    expect(list.items).toEqual([
      { calendarId: 'me@example.com', name: 'わたし', selected: true },
      { calendarId: 'school@group', name: '学校', selected: false },
    ]);

    const bad = await app.request('/v1/calendar/connection', {
      method: 'PUT',
      headers: H(),
      body: JSON.stringify({ calendarIds: ['someone-else@x'] }),
    });
    expect(bad.status).toBe(400);
    const put = await app.request('/v1/calendar/connection', {
      method: 'PUT',
      headers: H(),
      body: JSON.stringify({ calendarIds: ['school@group'] }),
    });
    expect(put.status).toBe(204);

    const res = await runSync({
      db,
      kb,
      vault,
      calendar: api,
      logger: new Logger('calendar-sync', () => undefined),
      now: () => NOW,
    });
    expect(res).toMatchObject({ failed: 0, revoked: 0 });

    const forA = (await (
      await app.request('/v1/context-events?childId=c_a', { headers: H() })
    ).json()) as Page<ContextEvent>;
    expect(forA.items.map((e) => [e.category, e.startDate, e.source])).toEqual([
      ['exam', '2026-11-25', 'calendar'],
      ['school_event', '2026-11-28', 'calendar'],
    ]);
    const forB = (await (
      await app.request('/v1/context-events?childId=c_b', { headers: H() })
    ).json()) as Page<ContextEvent>;
    expect(forB.items.map((e) => e.category)).toEqual(['school_event']);
  });

  it('disconnect revokes the token and removes calendar-sourced events only', async () => {
    const manual = await app.request('/v1/context-events', {
      method: 'POST',
      headers: H(),
      body: JSON.stringify({
        childIds: ['c_a'],
        category: 'sick',
        startDate: '2026-11-21',
        endDate: '2026-11-22',
      }),
    });
    expect(manual.status).toBe(201);
    const del = await app.request('/v1/calendar/connection', { method: 'DELETE', headers: H() });
    expect(del.status).toBe(204);
    expect(api.revoked).toContain('rt_good');
    expect((await db.doc(`families/${F}/calendarConnections/${G}`).get()).exists).toBe(false);
    const left = (await (
      await app.request('/v1/context-events?childId=c_a', { headers: H() })
    ).json()) as Page<ContextEvent>;
    expect(left.items.map((e) => e.source)).toEqual(['manual']);
    expect(
      (await app.request('/v1/calendar/connection', { method: 'DELETE', headers: H() })).status,
    ).toBe(204);
    expect((await app.request('/v1/calendar/calendars', { headers: H() })).status).toBe(404);
  });

  it('never logs tokens or event titles', () => {
    const all = logs.join('\n');
    for (const s of ['rt_good', 'rt_partial', '期末', '運動会']) expect(all).not.toContain(s);
  });
});

describe('manual context events', () => {
  it('validates input and family membership', async () => {
    const post = (body: unknown, g = G) =>
      app.request('/v1/context-events', {
        method: 'POST',
        headers: H(g),
        body: JSON.stringify(body),
      });
    const ok = {
      childIds: ['c_b'],
      category: 'travel',
      startDate: '2026-12-01',
      endDate: '2026-12-03',
    };
    expect((await post({ ...ok, endDate: '2026-11-30' })).status).toBe(400);
    expect((await post({ ...ok, category: 'party' })).status).toBe(400);
    expect((await post({ ...ok, childIds: ['c_nope'] })).status).toBe(404);
    expect((await post(ok, 'g_other')).status).toBe(404);
    expect((await app.request('/v1/context-events', { headers: H() })).status).toBe(400);
    expect(
      (await app.request('/v1/context-events?childId=c_a', { headers: H('g_other') })).status,
    ).toBe(404);

    const created = (await (await post(ok)).json()) as ContextEvent;
    expect(created).toMatchObject({ ...ok, source: 'manual' });
    expect(Object.keys(created).sort()).toEqual(
      ['category', 'childIds', 'endDate', 'eventId', 'source', 'startDate'].sort(),
    );
    const del = (id: string, g = G) =>
      app.request(`/v1/context-events/${id}`, { method: 'DELETE', headers: H(g) });
    expect((await del(created.eventId, 'g_other')).status).toBe(404);
    expect((await del(created.eventId)).status).toBe(204);
    expect((await del(created.eventId)).status).toBe(404);
  });

  it('refuses to delete calendar-sourced events', async () => {
    await db.doc(`families/${F}/contextEvents/cal-x`).set({
      childIds: ['c_a'],
      category: 'exam',
      source: 'calendar',
      startDate: '2026-12-10',
      endDate: '2026-12-10',
      createdBy: G,
    });
    const res = await app.request('/v1/context-events/cal-x', { method: 'DELETE', headers: H() });
    expect(res.status).toBe(400);
  });
});
