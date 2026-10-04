import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Firestore, type DocumentReference } from '@google-cloud/firestore';
import { TokenVault } from '@ijime/crypto';
import { FsKbSource, Kb } from '@ijime/kb-loader';
import { Logger, MemoryCalendarApi, type CalendarEvent } from '@ijime/service-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { externalEventHash } from './dates.js';
import type { CalendarSyncDeps } from './deps.js';
import { calendarEventDocId, refreshTokenAad, runSync } from './sync.js';

const KB_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../kb/v0.1.0');
const NOW = new Date('2026-11-20T01:00:00Z');
const SENTINEL = 'ZZSENTINELZZ';

let db: Firestore;
let kb: Kb;
const vault = TokenVault.dev();
const logs: string[] = [];
const api = new MemoryCalendarApi();

function deps(): CalendarSyncDeps {
  return {
    db,
    kb,
    vault,
    calendar: api,
    logger: new Logger('calendar-sync', (l) => logs.push(l)),
    now: () => NOW,
  };
}

const allDay = (
  id: string,
  summary: string,
  start: string,
  endExclusive: string,
): CalendarEvent => ({
  id,
  summary,
  start: { date: start },
  end: { date: endExclusive },
});

async function seedFamily(f: string, g: string, token: string, children: object[]) {
  for (const c of children) {
    const child = c as { childId: string };
    await db.doc(`families/${f}/children/${child.childId}`).set({ status: 'active', ...child });
  }
  await db.doc(`families/${f}/calendarConnections/${g}`).set({
    calendarIds: ['primary', 'school'],
    refreshTokenEnc: await vault.seal(token, refreshTokenAad(f, g)),
    scopes: [],
    status: 'active',
  });
}

const ctxDocs = async (f: string) =>
  Object.fromEntries(
    (await db.collection(`families/${f}/contextEvents`).get()).docs.map((d) => [d.id, d.data()]),
  );
const docId = (cal: string, ev: string) => calendarEventDocId(externalEventHash(cal, ev));

async function dumpTree(ref: DocumentReference, out: unknown[]): Promise<void> {
  const snap = await ref.get();
  if (snap.exists) out.push(snap.data());
  for (const col of await ref.listCollections())
    for (const d of await col.listDocuments()) await dumpTree(d, out);
}

beforeAll(async () => {
  if (!process.env['FIRESTORE_EMULATOR_HOST']) throw new Error('needs Firestore emulator');
  db = new Firestore({ projectId: `demo-sync-${randomUUID().slice(0, 8)}` });
  kb = await Kb.load(new FsKbSource(KB_DIR));

  await seedFamily('f1', 'g1', 'rt1', [
    { childId: 'c1', nickname: 'はな' },
    { childId: 'c2', nickname: 'ゆう' },
    { childId: 'c3', nickname: 'そら', dataSources: { calendar: false } },
  ]);
  api.accounts.set('rt1', {
    calendars: [{ id: 'primary', summary: 'me', primary: true }],
    events: {
      primary: [
        allDay('e1', `ハナ 期末テスト ${SENTINEL}`, '2026-11-25', '2026-11-27'),
        allDay('e2', `冬休み ${SENTINEL}`, '2026-12-24', '2027-01-08'),
        allDay('e3', `歯医者 ${SENTINEL}`, '2026-11-21', '2026-11-22'),
        { ...allDay('e4', '運動会', '2026-11-22', '2026-11-23'), status: 'cancelled' },
        allDay('e5', `そら 運動会 ${SENTINEL}`, '2026-11-22', '2026-11-23'),
      ],
      school: [
        {
          id: 's1',
          summary: `修学旅行 ${SENTINEL}`,
          start: { dateTime: '2026-11-30T07:00:00+09:00' },
          end: { dateTime: '2026-12-02T18:00:00+09:00' },
        },
      ],
    },
  });
  // 取得範囲外の古いカレンダー由来のコンテキスト情報と、手動で登録したコンテキスト情報は、どちらも削除してはならない
  await db.doc('families/f1/contextEvents/cal-old').set({
    childIds: ['c1'],
    category: 'exam',
    source: 'calendar',
    startDate: '2026-07-01',
    endDate: '2026-07-02',
    externalEventHash: 'old',
    createdBy: 'g1',
  });
  await db.doc('families/f1/contextEvents/manual1').set({
    childIds: ['c1'],
    category: 'sick',
    source: 'manual',
    startDate: '2026-11-19',
    endDate: '2026-11-19',
    createdBy: 'g1',
  });

  await seedFamily('f2', 'g2', 'rt2', [{ childId: 'c4', nickname: 'りく' }]);
  api.accounts.set('rt2', { calendars: [], events: {}, fail: new Error('upstream 500') });

  await seedFamily('f3', 'g3', 'rt3-dead', [{ childId: 'c5', nickname: 'めい' }]);
});
afterAll(() => db.terminate());

describe('runSync', () => {
  it('creates context events, isolating per-family failures', async () => {
    const res = await runSync(deps());
    expect(res).toEqual({ connections: 3, failed: 1, revoked: 1 });

    const docs = await ctxDocs('f1');
    expect(docs[docId('primary', 'e1')]).toEqual({
      childIds: ['c1'],
      category: 'exam',
      source: 'calendar',
      startDate: '2026-11-25',
      endDate: '2026-11-26',
      externalEventHash: externalEventHash('primary', 'e1'),
      createdBy: 'g1',
    });
    expect(docs[docId('primary', 'e2')]).toMatchObject({
      childIds: ['c1', 'c2'],
      category: 'long_vacation',
      endDate: '2027-01-07',
    });
    expect(docs[docId('school', 's1')]).toMatchObject({
      category: 'school_event',
      startDate: '2026-11-30',
      endDate: '2026-12-02',
    });
    // 無関係な予定、キャンセル済みの予定、カレンダーを無効にした子どもだけに紐づく予定は、どれも書き込まれない
    expect(docs[docId('primary', 'e3')]).toBeUndefined();
    expect(docs[docId('primary', 'e4')]).toBeUndefined();
    expect(docs[docId('primary', 'e5')]).toBeUndefined();
    expect(docs[docId('primary', 'e2')]!['childIds']).not.toContain('c3');
    expect(docs['cal-old']).toBeDefined();
    expect(docs['manual1']).toBeDefined();

    const conn = (await db.doc('families/f1/calendarConnections/g1').get()).data()!;
    expect(conn['status']).toBe('active');
    expect(conn['lastSyncAt'].toDate()).toEqual(NOW);
    expect((await db.doc('families/f2/calendarConnections/g2').get()).data()!['status']).toBe(
      'error',
    );
    expect((await db.doc('families/f3/calendarConnections/g3').get()).data()!['status']).toBe(
      'revoked',
    );

    expect(api.listCalls[0]).toMatchObject({
      timeMin: '2026-11-13T00:00:00+09:00',
      timeMax: '2027-01-20T00:00:00+09:00',
    });
  });

  it('is idempotent, follows date changes and removes deleted events', async () => {
    await runSync(deps());
    const before = await ctxDocs('f1');
    await runSync(deps());
    expect(await ctxDocs('f1')).toEqual(before);

    const acct = api.accounts.get('rt1')!;
    acct.events['primary'] = [
      allDay('e1', `はな 期末テスト ${SENTINEL}`, '2026-12-01', '2026-12-03'),
    ];
    acct.events['school'] = [];
    await runSync(deps());
    const docs = await ctxDocs('f1');
    expect(docs[docId('primary', 'e1')]).toMatchObject({
      startDate: '2026-12-01',
      endDate: '2026-12-02',
    });
    expect(docs[docId('primary', 'e2')]).toBeUndefined();
    expect(docs[docId('school', 's1')]).toBeUndefined();
    expect(Object.keys(docs).sort()).toEqual(['cal-old', docId('primary', 'e1'), 'manual1'].sort());
  });

  it('skips connections that are no longer active', async () => {
    const calls = api.listCalls.length;
    await runSync(deps());
    expect(api.listCalls.filter((c) => c.calendarId === 'primary').length).toBeGreaterThan(0);
    const after = api.listCalls.slice(calls);
    // f2（error）と f3（revoked）は処理されなくなり、f1 の2つのカレンダーだけが残る
    expect(after).toHaveLength(2);
  });

  it('never writes or logs event titles', async () => {
    const tree: unknown[] = [];
    for (const f of ['f1', 'f2', 'f3']) await dumpTree(db.doc(`families/${f}`), tree);
    const stored = JSON.stringify(tree, (_k, v) =>
      v && typeof v === 'object' && v.type === 'Buffer' ? '[bytes]' : v,
    );
    expect(stored).not.toContain(SENTINEL);
    expect(stored).not.toContain('期末');
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join('\n')).not.toContain(SENTINEL);
  });
});
