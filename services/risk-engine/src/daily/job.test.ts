import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Firestore } from '@google-cloud/firestore';
import { refreshTokenAad, runSync } from '@ijime/calendar-sync/src/sync.js';
import { TokenVault } from '@ijime/crypto';
import { FsKbSource, Kb } from '@ijime/kb-loader';
import { Logger, MemoryCalendarApi, MemoryPublisher, MemoryTaskQueue } from '@ijime/service-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { addDays } from './calendar.js';
import { MemoryFeatureStore, type DailyFeatureRow } from './feature-store.js';
import { MemoryExternalChildData } from '../deletion.js';
import { runDailyJob, type DailyJobDeps } from './job.js';

const KB_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../../kb/v0.1.0');
const D = '2026-11-20';
const NOW = new Date('2026-11-20T18:00:00Z');

let db: Firestore;
let kb: Kb;
const store = new MemoryFeatureStore();

beforeAll(async () => {
  if (!process.env['FIRESTORE_EMULATOR_HOST']) throw new Error('needs Firestore emulator');
  // Collection-group jobs must not read another suite's calendar connections.
  db = new Firestore({ projectId: `demo-daily-${randomUUID().slice(0, 8)}` });
  kb = await Kb.load(new FsKbSource(KB_DIR));
});
afterAll(() => db.terminate());

const base = (c: string) => `families/f_${c}/children/${c}`;
const pid = (c: string) => `p${Buffer.from(c).toString('hex')}`;

async function seedChild(c: string, opts: { level?: string; createdAt?: Date } = {}) {
  await db.doc(base(c)).set({
    childId: c,
    familyId: `f_${c}`,
    nickname: 'はな',
    gradeBand: 'high',
    pseudoId: pid(c),
    status: 'active',
    currentRiskLevel: opts.level ?? 'l0',
    careFlag: (opts.level ?? 'l0') !== 'l0',
    createdAt: opts.createdAt ?? new Date('2026-08-01T00:00:00Z'),
  });
}

// 過去 49 日分の日次特徴。直近 badDays 日（D を含まない）は a と i の2領域が悪化している
async function seedHistory(c: string, badDays: number) {
  for (let i = 49; i >= 1; i--) {
    const date = addDays(D, -i);
    const bad = i <= badDays;
    const row = (name: string, domain: string, value: number): DailyFeatureRow => ({
      pseudo_id: pid(c),
      feature_date: date,
      domain,
      feature_name: name,
      value,
      grade_band: 'high',
      kb_version: kb.version,
    });
    const existing = store.rows('daily_features', date).filter((r) => r.pseudo_id !== pid(c));
    await store.writePartition('daily_features', date, [
      ...existing,
      row('a_valence_mean', 'a', bad ? -0.6 : 0.4 + (i % 5) * 0.05),
      row('i_message_count', 'i', bad ? 1 : 10 + (i % 5)),
    ]);
  }
}

// 当日の signals：気分がとても低く、メッセージは1通だけ
async function seedTodaySignals(c: string, bad: boolean) {
  const sig = (id: string, domain: string, name: string, value: number) =>
    db.doc(`${base(c)}/signals/${id}`).set({
      domain,
      signalDefId: id,
      value: 1,
      explicit: false,
      metric: { name, value },
      sourceRef: 'm',
      kbVersion: kb.version,
      extractedBy: 'rule',
      localDate: D,
      createdAt: NOW,
      expireAt: NOW,
    });
  await sig('A-VAL-001', 'a', 'a_valence', bad ? -0.6 : 0.5);
  if (bad) await sig('I-HOUR-001', 'i', 'i_message_hour', 15);
  else for (let k = 0; k < 12; k++) await sig(`I-HOUR-${k}`, 'i', 'i_message_hour', 15);
}

function deps() {
  const lines: string[] = [];
  const publisher = new MemoryPublisher();
  const tasks = new MemoryTaskQueue();
  const d: DailyJobDeps = {
    db,
    kb,
    publisher,
    tasks,
    store,
    logger: new Logger('risk-engine', (l) => lines.push(l)),
    notifierUrl: 'http://notifier.test',
    external: new MemoryExternalChildData(),
    now: () => NOW,
  };
  return { d, lines, publisher, tasks };
}

const read = async (path: string) => (await db.doc(path).get()).data()!;
const list = async (path: string) => (await db.collection(path).get()).docs;

describe('daily job', () => {
  it('S5: 28-day baseline plus 7 days in two domains raises L2 with one consultation', async () => {
    const c = 'c_d1';
    await seedChild(c);
    await seedHistory(c, 6);
    await seedTodaySignals(c, true);
    const t = deps();
    const res = await runDailyJob(t.d, D);
    expect(res.failed).toBe(0);

    expect(await read(base(c))).toMatchObject({ currentRiskLevel: 'l2', careFlag: true });
    const assessments = await list(`${base(c)}/riskAssessments`);
    expect(assessments).toHaveLength(1);
    expect(assessments[0]!.data()).toMatchObject({
      level: 'l2',
      previousLevel: 'l0',
      trigger: 'daily',
      domainsFlagged: ['a', 'i'],
      inColdStart: false,
      explanation: { domains: ['a', 'i'], days: 7 },
    });
    const consults = await list(`${base(c)}/consultations`);
    expect(consults).toHaveLength(1);
    expect(consults[0]!.data()).toMatchObject({ level: 'l2', offerCount: 0 });
    expect(t.publisher.of('risk.level_changed')).toContainEqual({
      childId: c,
      assessmentId: assessments[0]!.id,
      from: 'l0',
      to: 'l2',
    });
    // L2 では期限タスクを登録しない。再度の問いかけはペットが followUpAt に従って行う
    expect(t.tasks.take('consultation-timeout')).toEqual([]);

    const features = store.rows('daily_features', D).filter((r) => r.pseudo_id === pid(c));
    expect(features.find((r) => r.feature_name === 'a_valence_mean')?.value).toBe(-0.6);
    expect(features.find((r) => r.feature_name === 'i_message_count')?.value).toBe(1);
    expect(JSON.stringify(store.rows('daily_features', D))).not.toContain(c);
    expect(store.rows('risk_levels_daily', D)).toContainEqual({
      pseudo_id: pid(c),
      date: D,
      level: 'l2',
      domains_flagged: ['a', 'i'],
      rules_version: kb.version,
    });
    expect(
      store
        .rows('baselines', D)
        .filter((b) => b.pseudo_id === pid(c))
        .map((b) => b.feature_name),
    ).toEqual(['a_valence_mean', 'i_message_count']);
    expect(store.anomalyRuns.at(-1)).toMatchObject({ date: D, opts: { retrain: false } });

    // 同じ日の再実行：結果は変わらず、2件目の評価や相談は作らない
    await runDailyJob(deps().d, D);
    expect(await list(`${base(c)}/riskAssessments`)).toHaveLength(1);
    expect(await list(`${base(c)}/consultations`)).toHaveLength(1);
  });

  it('S6: the same deviation inside a calendar-synced exam week stays below L2', async () => {
    const c = 'c_d6';
    const f = `f_${c}`;
    await seedChild(c);
    await seedHistory(c, 6);
    await seedTodaySignals(c, true);

    const vault = TokenVault.dev();
    await db.doc(`families/${f}/calendarConnections/g6`).set({
      calendarIds: ['primary'],
      refreshTokenEnc: await vault.seal('rt6', refreshTokenAad(f, 'g6')),
      scopes: [],
      status: 'active',
    });
    const calendar = new MemoryCalendarApi();
    calendar.accounts.set('rt6', {
      calendars: [],
      events: {
        primary: [
          {
            id: 'exam-week',
            summary: '期末テスト',
            start: { date: addDays(D, -6) },
            end: { date: addDays(D, 1) },
          },
        ],
      },
    });
    const sync = await runSync({
      db,
      kb,
      vault,
      calendar,
      logger: new Logger('calendar-sync', () => undefined),
      now: () => NOW,
    });
    expect(sync).toEqual({ connections: 1, failed: 0, revoked: 0 });
    expect((await list(`families/${f}/contextEvents`)).map((d) => d.data()['category'])).toEqual([
      'exam',
    ]);

    const t = deps();
    await runDailyJob(t.d, D);
    const child = await read(base(c));
    expect(['l0', 'l1']).toContain(child['currentRiskLevel']);
    expect(await list(`${base(c)}/consultations`)).toHaveLength(0);
    expect(
      store
        .rows('daily_features', D)
        .find((r) => r.pseudo_id === pid(c) && r.feature_name === 'x_exam_flag')?.value,
    ).toBe(1);
  });

  it('observe signals are recorded in daily_features but never judged', async () => {
    const c = 'c_d_obs';
    await seedChild(c);
    await seedHistory(c, 0);
    await seedTodaySignals(c, false);
    const signal = (id: string, data: Record<string, unknown>) =>
      db.doc(`${base(c)}/signals/${id}`).set({
        value: 1,
        sourceRef: 'm',
        kbVersion: kb.version,
        extractedBy: 'rule',
        localDate: D,
        createdAt: NOW,
        expireAt: NOW,
        ...data,
      });
    await signal('self', {
      domain: 'd',
      signalDefId: 'D-SELF-001',
      scoring: 'observe',
      explicit: false,
      metric: { name: 'd_self_size_ratio', value: 0.01 },
    });
    await signal('obs-explicit', {
      domain: 'a',
      signalDefId: 'A-EXCL-003',
      scoring: 'observe',
      explicit: true,
    });
    await runDailyJob(deps().d, D);

    expect((await read(base(c)))['currentRiskLevel']).toBe('l0');
    const features = store.rows('daily_features', D).filter((r) => r.pseudo_id === pid(c));
    expect(features.find((r) => r.feature_name === 'd_self_size_mean')?.value).toBe(0.01);
    expect(
      store
        .rows('baselines', D)
        .filter((b) => b.pseudo_id === pid(c))
        .some((b) => b.feature_name.startsWith('d_')),
    ).toBe(false);
  });

  it('cold start holds back L2 and records baselineReadyAt', async () => {
    const c = 'c_d2';
    await seedChild(c, { createdAt: new Date('2026-11-01T00:00:00Z') });
    await seedHistory(c, 6);
    await seedTodaySignals(c, true);
    await runDailyJob(deps().d, D);
    const child = await read(base(c));
    expect(child['currentRiskLevel']).toBe('l0');
    expect(child['baselineReadyAt'].toDate().toISOString()).toBe('2026-11-29T00:00:00.000Z');
    expect(await list(`${base(c)}/consultations`)).toHaveLength(0);
  });

  it('keeps L3 while its consultation is unanswered, then follows the rules', async () => {
    const c = 'c_d3';
    await seedChild(c, { level: 'l3' });
    await seedHistory(c, 0);
    await seedTodaySignals(c, false);
    await db.doc(`${base(c)}/consultations/k1`).set({
      assessmentId: 'a',
      level: 'l3',
      offeredAt: new Date('2026-11-19T00:00:00Z'),
      offerCount: 1,
    });
    await runDailyJob(deps().d, D);
    expect((await read(base(c)))['currentRiskLevel']).toBe('l3');

    await db.doc(`${base(c)}/consultations/k1`).update({ choice: 'self' });
    await db
      .doc(`${base(c)}/riskAssessments/${(await list(`${base(c)}/riskAssessments`))[0]!.id}`)
      .delete();
    const t = deps();
    await runDailyJob(t.d, D);
    expect(await read(base(c))).toMatchObject({ currentRiskLevel: 'l0', careFlag: false });
    expect(t.publisher.of('risk.level_changed')).toContainEqual(
      expect.objectContaining({ childId: c, from: 'l3', to: 'l0' }),
    );
  });

  it('keeps L4 while a crisis is open', async () => {
    const c = 'c_d4';
    await seedChild(c, { level: 'l4' });
    await seedHistory(c, 0);
    await seedTodaySignals(c, false);
    await db.doc(`${base(c)}/crisisEvents/k1`).set({ status: 'guardian_acknowledged' });
    await runDailyJob(deps().d, D);
    expect((await read(base(c)))['currentRiskLevel']).toBe('l4');
  });
});

describe('crisis closure 24 hours after acknowledgement', () => {
  it('closes the event and stops holding L4 once the acknowledgement is 24 hours old', async () => {
    const c = 'c_d4_closed';
    await seedChild(c, { level: 'l4' });
    await seedHistory(c, 0);
    await seedTodaySignals(c, false);
    const ref = db.doc(`${base(c)}/crisisEvents/k1`);
    await ref.set({
      status: 'guardian_acknowledged',
      timeline: [{ step: 'guardian_acknowledged', at: new Date(NOW.getTime() - 25 * 3_600_000) }],
    });
    await runDailyJob(deps().d, D);
    const event = (await ref.get()).data()!;
    expect(event['status']).toBe('closed');
    expect(event['timeline']).toContainEqual(expect.objectContaining({ step: 'closed' }));
    expect((await read(base(c)))['currentRiskLevel']).not.toBe('l4');
  });

  it('keeps the event and L4 while the acknowledgement is younger than 24 hours', async () => {
    const c = 'c_d4_recent';
    await seedChild(c, { level: 'l4' });
    await seedHistory(c, 0);
    await seedTodaySignals(c, false);
    const ref = db.doc(`${base(c)}/crisisEvents/k1`);
    await ref.set({
      status: 'guardian_acknowledged',
      timeline: [{ step: 'guardian_acknowledged', at: new Date(NOW.getTime() - 23 * 3_600_000) }],
    });
    await runDailyJob(deps().d, D);
    expect((await ref.get()).get('status')).toBe('guardian_acknowledged');
    expect((await read(base(c)))['currentRiskLevel']).toBe('l4');
  });

  it.each([
    [
      'child_acknowledged 25 hours ago',
      {
        status: 'child_acknowledged',
        familyHarmSuspected: true,
        createdAt: new Date(NOW.getTime() - 3 * 86_400_000),
        timeline: [{ step: 'child_acknowledged', at: new Date(NOW.getTime() - 25 * 3_600_000) }],
      },
    ],
    [
      'open family harm 8 days old',
      {
        status: 'open',
        familyHarmSuspected: true,
        createdAt: new Date(NOW.getTime() - 8 * 86_400_000),
      },
    ],
  ])('closes a family-harm event that expired: %s', async (_name, event) => {
    const c = `c_fh_${_name.length}`;
    await seedChild(c, { level: 'l4' });
    await seedHistory(c, 0);
    await seedTodaySignals(c, false);
    const ref = db.doc(`${base(c)}/crisisEvents/k1`);
    await ref.set(event);
    await runDailyJob(deps().d, D);
    expect((await ref.get()).get('status')).toBe('closed');
    expect((await read(base(c)))['currentRiskLevel']).not.toBe('l4');
  });

  it('keeps an open family-harm event and L4 while it is younger than 7 days', async () => {
    const c = 'c_fh_recent';
    await seedChild(c, { level: 'l4' });
    await seedHistory(c, 0);
    await seedTodaySignals(c, false);
    const ref = db.doc(`${base(c)}/crisisEvents/k1`);
    await ref.set({
      status: 'open',
      familyHarmSuspected: true,
      createdAt: new Date(NOW.getTime() - 6 * 86_400_000),
    });
    await runDailyJob(deps().d, D);
    expect((await ref.get()).get('status')).toBe('open');
    expect((await read(base(c)))['currentRiskLevel']).toBe('l4');
  });
});

describe('sharded daily job', () => {
  it('two concurrent tasks split the children, keep each other’s rows and refresh anomalies once', async () => {
    const shardDb = new Firestore({ projectId: `demo-shard-${randomUUID().slice(0, 8)}` });
    const ids = Array.from({ length: 12 }, (_, i) => `c_s${i}`);
    for (const c of ids) {
      await shardDb.doc(base(c)).set({
        childId: c,
        familyId: `f_${c}`,
        nickname: 'はな',
        gradeBand: 'high',
        pseudoId: pid(c),
        status: 'active',
        currentRiskLevel: 'l0',
        careFlag: false,
        createdAt: new Date('2026-08-01T00:00:00Z'),
      });
    }
    const shardStore = new MemoryFeatureStore();
    const run = (index: number) =>
      runDailyJob({ ...deps().d, db: shardDb, store: shardStore }, D, {
        shard: { index, count: 2 },
        executionId: 'exec-1',
      });
    try {
      const [a, b] = await Promise.all([run(0), run(1)]);
      expect(a.processed).toBeGreaterThan(0);
      expect(b.processed).toBeGreaterThan(0);
      expect(a.processed + b.processed).toBe(ids.length);
      const levels = () => shardStore.rows('risk_levels_daily', D).map((r) => r.pseudo_id);
      expect(levels().sort()).toEqual(ids.map(pid).sort());
      expect(shardStore.anomalyRuns).toHaveLength(1);

      // Cloud Run が同じ task をリトライ：行を重複して書かず、異常検知も再実行しない
      await run(0);
      expect(levels().sort()).toEqual(ids.map(pid).sort());
      expect(shardStore.anomalyRuns).toHaveLength(1);
      const runs = await shardDb.collection('jobRuns').get();
      expect(runs.docs.map((d) => d.data()['doneTasks'])).toEqual([[0, 1]]);
    } finally {
      await shardDb.terminate();
    }
  });
});
