import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Firestore } from '@google-cloud/firestore';
import { DevChildDirectory, ScriptedLlm } from '@ijime/agent-core';
import { createApp as createApiApp } from '@ijime/api/src/app.js';
import { createApiRuntime } from '@ijime/api/src/runtime.js';
import { FsKbSource, Kb } from '@ijime/kb-loader';
import { createApp as createRiskApp } from '@ijime/risk-engine/src/app.js';
import { addDays } from '@ijime/risk-engine/src/daily/calendar.js';
import { MemoryFeatureStore } from '@ijime/risk-engine/src/daily/feature-store.js';
import { runDailyJob } from '@ijime/risk-engine/src/daily/job.js';
import {
  encodePushEnvelope,
  Logger,
  MemoryPublisher,
  MemoryTaskQueue,
  type ServiceApp,
} from '@ijime/service-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { LogOnlySender, MemorySender } from './channels.js';
import { careHintId, contentFreeId } from './consultation.js';
import type { NotificationDoc } from './store.js';
import { MemoryDailyFeatures } from './weekly-source.js';

// エンドツーエンドのシナリオ S3・S4：
// explicit signal.extracted → risk-engine → api で相談に回答 → consultation.resolved → notifier
const KB_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../kb/v0.1.0');
const SUMMARY = '学校で無視されてつらい';

let db: Firestore;
let kb: Kb;
let directory: DevChildDirectory;

beforeAll(async () => {
  if (!process.env['FIRESTORE_EMULATOR_HOST']) throw new Error('needs Firestore emulator');
  db = new Firestore({ projectId: 'demo-ijime' });
  kb = await Kb.load(new FsKbSource(KB_DIR));
  directory = new DevChildDirectory(db);
});
afterAll(() => db.terminate());

const push = (app: ServiceApp, path: string, payload: unknown) =>
  app.request(path, {
    method: 'POST',
    body: JSON.stringify(encodePushEnvelope(payload)),
    headers: { 'Content-Type': 'application/json' },
  });

async function world(childId: string) {
  const child = await directory.lookup(childId);
  const f = child.familyId;
  await db.doc(`families/${f}/guardians/g1`).set({
    guardianId: 'g1',
    email: 'a@example.com',
    notifyChannels: ['webpush', 'email'],
  });
  await db
    .doc(`families/${f}/devices/d1`)
    .set({ ownerType: 'guardian', ownerId: 'g1', fcmToken: 'tok-1', lastSeenAt: new Date() });
  const now = new Date();
  const localDate = new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
  await db.doc(`families/${f}/children/${childId}/signals/s_excl`).set({
    domain: 'a',
    signalDefId: 'A-EXCL-003',
    value: 0.9,
    explicit: true,
    sourceRef: 'm',
    kbVersion: kb.version,
    extractedBy: 'test',
    localDate,
    createdAt: now,
    expireAt: now,
  });

  const logger = new Logger('e2e', () => {});
  const publisher = new MemoryPublisher();
  const riskTasks = new MemoryTaskQueue();
  const risk = createRiskApp(
    async () => ({
      db,
      kb,
      publisher,
      tasks: riskTasks,
      logger,
      notifierUrl: 'http://notifier.test',
      now: () => now,
    }),
    logger,
  );

  const resolved: Record<string, unknown>[] = [];
  const rt = await createApiRuntime({
    kb,
    db,
    directory,
    logger,
    publish: async (topic, payload) => {
      if (topic === 'consultation.resolved') resolved.push(payload);
    },
    auth: { allowDevHeader: true },
  });
  const api = createApiApp({
    getKb: async () => kb,
    allowedOrigins: [],
    chat: async () => rt.chat,
  });

  const tasks = new MemoryTaskQueue();
  const writer = new ScriptedLlm(
    () => ({
      text: JSON.stringify({
        title: '最近の様子について',
        changes: ['会話の様子に、いつもと違う傾向が見られました'],
        meaning: 'ゆっくり話せる時間をつくってみてください',
        suggestions: { try: ['声をかける', 'そばにいる'], avoid: ['問い詰める'] },
      }),
    }),
    { model: 'scripted-writer' },
  );
  const notifier = createApp(
    async () => ({
      db,
      kb,
      model: writer,
      tasks,
      senders: {
        webpush: new MemorySender(),
        email: new LogOnlySender('email', logger),
        sms: new LogOnlySender('sms', logger),
      },
      logger,
      selfUrl: 'http://notifier.test',
      features: new MemoryDailyFeatures(),
      now: () => now,
    }),
    logger,
  );

  return { f, risk, riskTasks, api, notifier, tasks, resolved, writer };
}

async function raiseAndOffer(w: Awaited<ReturnType<typeof world>>, childId: string) {
  expect(
    (await push(w.risk, '/internal/assess', { childId, domains: ['a'], explicit: true })).status,
  ).toBe(204);
  const consults = await db.collection(`families/${w.f}/children/${childId}/consultations`).get();
  expect(consults.size).toBe(1);
  return consults.docs[0]!.id;
}

const choose = (w: Awaited<ReturnType<typeof world>>, childId: string, id: string, body: unknown) =>
  w.api.request(`/v1/child/consultations/${id}/choice`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Dev-Child-Id': childId },
    body: JSON.stringify(body),
  });

describe('end-to-end scenarios', () => {
  it('S3: explicit statement → L3 → proxy → care_hint with the verbatim summary', async () => {
    const childId = 'c_s3';
    const w = await world(childId);
    const consultationId = await raiseAndOffer(w, childId);
    expect(
      (
        await choose(w, childId, consultationId, {
          choice: 'proxy',
          summary: { text: SUMMARY, confirmed: true },
        })
      ).status,
    ).toBe(200);
    expect(w.resolved).toEqual([{ childId, consultationId, choice: 'proxy' }]);
    expect(
      (await push(w.notifier, '/internal/events/consultation-resolved', w.resolved[0])).status,
    ).toBe(204);

    const n = (
      await db.doc(`families/${w.f}/notifications/${careHintId(childId, consultationId)}`).get()
    ).data() as NotificationDoc;
    expect(n.kind).toBe('care_hint');
    expect(n.recipientIds).toEqual(['g1']);
    expect(n.payload.childSummary).toBe(SUMMARY);
    expect(n.payload.reason).toEqual({ domains: ['a'], days: 1 });
    expect(w.tasks.take('notify-send')).toHaveLength(2);

    // 子どもが回答済みなら、risk-engine が登録した期限タスクが実行時刻になってもお知らせを送らない
    const [timeout] = w.riskTasks.take('consultation-timeout');
    expect(
      (
        await w.notifier.request(new URL(timeout!.url).pathname, {
          method: 'POST',
          body: JSON.stringify(timeout!.body),
          headers: { 'Content-Type': 'application/json' },
        })
      ).status,
    ).toBe(204);
    const all = await db.collection(`families/${w.f}/notifications`).get();
    expect(all.docs.map((d) => d.id)).toEqual([careHintId(childId, consultationId)]);
  });

  it('S5: daily job → L2 → not_now → no notification, followUpAt set', async () => {
    const childId = 'c_s5';
    const w = await world(childId);
    const D = '2026-11-20';
    const child = await directory.lookup(childId);
    await db
      .doc(`families/${w.f}/children/${childId}`)
      .update({ createdAt: new Date('2026-08-01T00:00:00Z') });
    const pseudoId = `p_dev_${childId}`;
    const store = new MemoryFeatureStore();
    for (let i = 49; i >= 1; i--) {
      const date = addDays(D, -i);
      const bad = i <= 6;
      await store.writePartition(
        'daily_features',
        date,
        [
          ['a_valence_mean', 'a', bad ? -0.6 : 0.4 + (i % 5) * 0.05],
          ['i_message_count', 'i', bad ? 1 : 10 + (i % 5)],
        ].map(([name, domain, value]) => ({
          pseudo_id: pseudoId,
          feature_date: date,
          domain: domain as string,
          feature_name: name as string,
          value: value as number,
          grade_band: child.gradeBand,
          kb_version: kb.version,
        })),
      );
    }
    for (const [id, domain, name, value] of [
      ['A-VAL-001', 'a', 'a_valence', -0.6],
      ['I-HOUR-001', 'i', 'i_message_hour', 15],
    ] as const) {
      await db.doc(`families/${w.f}/children/${childId}/signals/${id}`).set({
        domain,
        signalDefId: id,
        value: 1,
        explicit: false,
        metric: { name, value },
        sourceRef: 'm',
        kbVersion: kb.version,
        extractedBy: 'rule',
        localDate: D,
        createdAt: new Date(),
        expireAt: new Date(),
      });
    }
    await db.doc(`families/${w.f}/children/${childId}/signals/s_excl`).delete();
    await runDailyJob(
      {
        db,
        kb,
        publisher: new MemoryPublisher(),
        tasks: new MemoryTaskQueue(),
        store,
        logger: new Logger('e2e', () => {}),
        notifierUrl: 'http://notifier.test',
        now: () => new Date('2026-11-20T18:00:00Z'),
      },
      D,
    );
    const consults = await db.collection(`families/${w.f}/children/${childId}/consultations`).get();
    expect(consults.docs.map((d) => d.data()['level'])).toEqual(['l2']);
    const consultationId = consults.docs[0]!.id;

    const res = await choose(w, childId, consultationId, { choice: 'not_now' });
    expect(await res.json()).toEqual({ notificationQueued: false });
    await push(w.notifier, '/internal/events/consultation-resolved', w.resolved[0]);
    expect((await db.collection(`families/${w.f}/notifications`).get()).size).toBe(0);
    const consult = (
      await db.doc(`families/${w.f}/children/${childId}/consultations/${consultationId}`).get()
    ).data()!;
    expect(consult['followUpAt']).toBeDefined();
  });

  it('S4: explicit statement → L3 → not_now → content_free_alert, no model call', async () => {
    const childId = 'c_s4';
    const w = await world(childId);
    const consultationId = await raiseAndOffer(w, childId);
    const res = await choose(w, childId, consultationId, { choice: 'not_now' });
    expect(await res.json()).toEqual({ notificationQueued: true });
    await push(w.notifier, '/internal/events/consultation-resolved', w.resolved[0]);

    const all = await db.collection(`families/${w.f}/notifications`).get();
    expect(all.docs.map((d) => d.id)).toEqual([contentFreeId(childId, consultationId)]);
    const n = all.docs[0]!.data() as NotificationDoc;
    expect(n.kind).toBe('content_free_alert');
    expect(n.payload.childSummary).toBeNull();
    expect(w.writer.requests).toHaveLength(0);
  });
});
