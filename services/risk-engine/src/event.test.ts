import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Firestore } from '@google-cloud/firestore';
import { consultation as consultConfig } from '@ijime/config';
import { FsKbSource, Kb, riskRulesSchema } from '@ijime/kb-loader';
import { encodePushEnvelope, Logger, MemoryPublisher, MemoryTaskQueue } from '@ijime/service-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { explicitL3 } from './levels.js';

const KB_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../kb/v0.1.0');
const NOW = new Date('2026-10-01T03:00:00Z');
const TODAY = '2026-10-01';

let db: Firestore;
let kb: Kb;

beforeAll(async () => {
  if (!process.env['FIRESTORE_EMULATOR_HOST']) throw new Error('needs Firestore emulator');
  db = new Firestore({ projectId: 'demo-ijime' });
  kb = await Kb.load(new FsKbSource(KB_DIR));
});
afterAll(() => db.terminate());

async function seedChild(f: string, c: string, level = 'l0') {
  await db.doc(`families/${f}/children/${c}`).set({
    childId: c,
    familyId: f,
    nickname: 'はな',
    gradeBand: 'high',
    currentRiskLevel: level,
    careFlag: false,
  });
}

async function seedSignal(f: string, c: string, id: string, domain: string, explicit: boolean) {
  await db.doc(`families/${f}/children/${c}/signals/${id}`).set({
    domain,
    signalDefId: domain === 'a' ? 'A-EXCL-003' : 'K-DEL-001',
    value: 0.9,
    explicit,
    sourceRef: 'x',
    kbVersion: kb.version,
    extractedBy: 'test',
    localDate: TODAY,
    createdAt: NOW,
    expireAt: NOW,
  });
}

function setup() {
  const lines: string[] = [];
  const logger = new Logger('risk-engine', (l) => lines.push(l));
  const publisher = new MemoryPublisher();
  const tasks = new MemoryTaskQueue();
  const app = createApp(
    async () => ({
      db,
      kb,
      publisher,
      tasks,
      logger,
      notifierUrl: 'http://notifier.test',
      now: () => NOW,
    }),
    logger,
  );
  const push = (path: string, payload: unknown) =>
    app.request(path, {
      method: 'POST',
      body: JSON.stringify(encodePushEnvelope(payload)),
      headers: { 'Content-Type': 'application/json' },
    });
  return { lines, publisher, tasks, push };
}

const read = async (path: string) => (await db.doc(path).get()).data();
const list = async (path: string) => (await db.collection(path).get()).docs;

describe('explicitL3', () => {
  it('only counts domains listed in or_explicit_in', async () => {
    const rules = await kb.yaml('rules/risk_rules.yaml', riskRulesSchema);
    expect(
      explicitL3(
        [
          { domain: 'a', signalDefId: 'A' },
          { domain: 'k', signalDefId: 'K' },
        ],
        rules,
      ),
    ).toEqual({ hit: true, domains: ['a'] });
    expect(explicitL3([{ domain: 'm', signalDefId: 'M' }], rules).hit).toBe(false);
  });
});

describe('event mode: explicit statement → L3 and one consultation', () => {
  it('raises to L3 regardless of cold start and creates exactly one consultation', async () => {
    const [f, c] = ['f_re1', 'c_re1'];
    await seedChild(f, c);
    await seedSignal(f, c, 's1', 'a', true);
    const t = setup();
    const ev = { childId: c, domains: ['a'], explicit: true };
    expect((await t.push('/internal/assess', ev)).status).toBe(204);

    const child = await read(`families/${f}/children/${c}`);
    expect(child).toMatchObject({ currentRiskLevel: 'l3', careFlag: true });
    const assessments = await list(`families/${f}/children/${c}/riskAssessments`);
    expect(assessments).toHaveLength(1);
    expect(assessments[0]!.data()).toMatchObject({
      level: 'l3',
      previousLevel: 'l0',
      trigger: 'event',
      domainsFlagged: ['a'],
      inColdStart: true,
      rulesVersion: kb.version,
      explanation: { domains: ['a'], days: 1, explicit: true },
    });
    const consults = await list(`families/${f}/children/${c}/consultations`);
    expect(consults).toHaveLength(1);
    expect(consults[0]!.data()).toMatchObject({
      assessmentId: assessments[0]!.id,
      level: 'l3',
      offerCount: 0,
    });
    expect(t.publisher.of('risk.level_changed')).toEqual([
      { childId: c, assessmentId: assessments[0]!.id, from: 'l0', to: 'l3' },
    ]);
    const timeouts = t.tasks.take('consultation-timeout');
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0]).toMatchObject({
      url: 'http://notifier.test/internal/tasks/consultation-timeout',
      body: { familyId: f, childId: c, consultationId: consults[0]!.id },
      delaySeconds: consultConfig.l3NoAnswerHours * 3600,
    });

    // 重複配信：2件目の評価や相談は作らない。イベントは再送されうる（少なくとも1回）が、内容は同じ
    expect((await t.push('/internal/assess', ev)).status).toBe(204);
    expect(await list(`families/${f}/children/${c}/riskAssessments`)).toHaveLength(1);
    expect(await list(`families/${f}/children/${c}/consultations`)).toHaveLength(1);
    expect(new Set(t.publisher.of('risk.level_changed').map((e) => e.assessmentId)).size).toBe(1);
    expect(t.tasks.take('consultation-timeout')).toEqual([]);
  });

  it('does nothing without an explicit signal in an L3 domain', async () => {
    const [f, c] = ['f_re2', 'c_re2'];
    await seedChild(f, c);
    await seedSignal(f, c, 's1', 'k', true);
    await seedSignal(f, c, 's2', 'a', false);
    const t = setup();
    expect(
      (await t.push('/internal/assess', { childId: c, domains: ['a', 'k'], explicit: true }))
        .status,
    ).toBe(204);
    expect(
      (await t.push('/internal/assess', { childId: c, domains: ['a'], explicit: false })).status,
    ).toBe(204);
    expect((await read(`families/${f}/children/${c}`))!['currentRiskLevel']).toBe('l0');
    expect(await list(`families/${f}/children/${c}/riskAssessments`)).toHaveLength(0);
    expect(t.publisher.published).toEqual([]);
  });

  it('ignores explicit signals marked observe (stored field or current kb)', async () => {
    const [f, c] = ['f_re_obs', 'c_re_obs'];
    await seedChild(f, c);
    await seedSignal(f, c, 's1', 'a', true);
    await db.doc(`families/${f}/children/${c}/signals/s1`).update({ scoring: 'observe' });
    await seedSignal(f, c, 's2', 'd', true);
    await db.doc(`families/${f}/children/${c}/signals/s2`).update({ signalDefId: 'D-STORY-001' });
    const t = setup();
    await t.push('/internal/assess', { childId: c, domains: ['a', 'd'], explicit: true });
    expect((await read(`families/${f}/children/${c}`))!['currentRiskLevel']).toBe('l0');
    expect(await list(`families/${f}/children/${c}/riskAssessments`)).toHaveLength(0);
  });

  it('reuses an open L2 consultation instead of opening a second one', async () => {
    const [f, c] = ['f_re3', 'c_re3'];
    await seedChild(f, c, 'l2');
    await db.doc(`families/${f}/children/${c}/consultations/open1`).set({
      assessmentId: 'a0',
      level: 'l2',
      offeredAt: new Date('2026-09-30T00:00:00Z'),
      offerCount: 1,
    });
    await seedSignal(f, c, 's1', 'a', true);
    const t = setup();
    await t.push('/internal/assess', { childId: c, domains: ['a'], explicit: true });
    const consults = await list(`families/${f}/children/${c}/consultations`);
    expect(consults.map((d) => d.id)).toEqual(['open1']);
    expect(consults[0]!.data()['level']).toBe('l3');
    expect(t.tasks.take('consultation-timeout')[0]!.body['consultationId']).toBe('open1');
  });

  it('never lowers L4', async () => {
    const [f, c] = ['f_re4', 'c_re4'];
    await seedChild(f, c, 'l4');
    await seedSignal(f, c, 's1', 'a', true);
    const t = setup();
    await t.push('/internal/assess', { childId: c, domains: ['a'], explicit: true });
    expect((await read(`families/${f}/children/${c}`))!['currentRiskLevel']).toBe('l4');
    expect(await list(`families/${f}/children/${c}/consultations`)).toHaveLength(0);
  });
});

describe('crisis.detected → L4', () => {
  it('writes an L4 assessment once and publishes the change', async () => {
    const [f, c] = ['f_re5', 'c_re5'];
    await seedChild(f, c, 'l1');
    const t = setup();
    const ev = { childId: c, crisisId: 'k1', familyHarmSuspected: true };
    expect((await t.push('/internal/events/crisis-detected', ev)).status).toBe(204);
    expect((await t.push('/internal/events/crisis-detected', ev)).status).toBe(204);
    expect((await read(`families/${f}/children/${c}`))!['currentRiskLevel']).toBe('l4');
    const a = await list(`families/${f}/children/${c}/riskAssessments`);
    expect(a).toHaveLength(1);
    expect(a[0]!.data()).toMatchObject({ level: 'l4', previousLevel: 'l1' });
    const changes = t.publisher.of('risk.level_changed');
    expect(changes.length).toBeGreaterThan(0);
    for (const e of changes) {
      expect(e).toEqual({ childId: c, assessmentId: a[0]!.id, from: 'l1', to: 'l4' });
    }
    expect(await list(`families/${f}/children/${c}/consultations`)).toHaveLength(0);
  });
});
