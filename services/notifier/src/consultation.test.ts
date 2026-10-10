import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Firestore } from '@google-cloud/firestore';
import { ScriptedLlm, type Script } from '@ijime/agent-core';
import { FsKbSource, Kb } from '@ijime/kb-loader';
import { encodePushEnvelope, Logger, MemoryTaskQueue } from '@ijime/service-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { LogOnlySender, MemorySender } from './channels.js';
import { careHintId, contentFreeId, staticCareHint } from './consultation.js';
import { loadTemplate, type NotifierDeps } from './deps.js';
import type { NotificationDoc } from './store.js';
import { loadAdviceObservationPatterns, violations, type WriterOutput } from './writer.js';
import { MemoryDailyFeatures } from './weekly-source.js';

const KB_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../kb/v0.1.0');
const SUMMARY = '学校で無視されてつらい';
const SENTINEL = 'SENTINEL_会話の原文';

const GOOD: WriterOutput = {
  title: 'はなさんからの相談',
  changes: [],
  meaning:
    'お子さんが共有に同意した内容をお届けします。出来事を第三者が確認したものではありません。まずは落ち着いてお話を聞いてみてください。',
  suggestions: {
    try: ['「最近どう？」と声をかける', '一緒に過ごす時間を少し増やす'],
    avoid: ['問い詰める'],
  },
};

let db: Firestore;
let kb: Kb;

beforeAll(async () => {
  if (!process.env['FIRESTORE_EMULATOR_HOST']) throw new Error('needs Firestore emulator');
  db = new Firestore({ projectId: 'demo-ijime' });
  kb = await Kb.load(new FsKbSource(KB_DIR));
});
afterAll(() => db.terminate());

async function seed(
  f: string,
  c: string,
  consult: { id: string; level: 'l2' | 'l3'; assessmentId: string; choice?: string },
) {
  const base = `families/${f}/children/${c}`;
  await db.doc(base).set({ childId: c, familyId: f, nickname: 'はな', gradeBand: 'high' });
  await db.doc(`families/${f}/guardians/g1`).set({
    guardianId: 'g1',
    email: 'a@example.com',
    notifyChannels: ['webpush', 'email'],
  });
  await db.doc(`families/${f}/guardians/g2`).set({
    guardianId: 'g2',
    email: 'b@example.com',
    notifyChannels: ['email'],
  });
  await db
    .doc(`families/${f}/devices/d1`)
    .set({ ownerType: 'guardian', ownerId: 'g1', fcmToken: 'tok-1', lastSeenAt: new Date() });
  await db.doc(`${base}/riskAssessments/a1`).set({
    level: consult.level,
    explanation: { domains: ['a'], days: 1, explicit: true },
  });
  await db.doc(`${base}/sessions/s/messages/m`).set({ role: 'child', text: SENTINEL });
  const { id, ...rest } = consult;
  await db
    .doc(`${base}/consultations/${id}`)
    .set({ offeredAt: new Date(), offerCount: 1, ...rest });
}

async function seedDraft(f: string, c: string, consultationId: string) {
  await db.doc(`families/${f}/notifications/${careHintId(c, consultationId)}`).set({
    childId: c,
    recipientIds: [],
    kind: 'care_hint',
    level: 'l3',
    templateId: '',
    payload: { childSummary: SUMMARY },
    channels: [],
    status: 'queued',
    attempts: [],
    createdAt: new Date(),
  });
}

function setup(script: Script) {
  const lines: string[] = [];
  const logger = new Logger('notifier', (l) => lines.push(l));
  const tasks = new MemoryTaskQueue();
  const llm = new ScriptedLlm(script, { model: 'scripted-writer' });
  const deps: NotifierDeps = {
    db,
    kb,
    model: llm,
    tasks,
    senders: {
      webpush: new MemorySender(),
      email: new LogOnlySender('email', logger),
      sms: new LogOnlySender('sms', logger),
    },
    logger,
    selfUrl: 'http://notifier.test',
    features: new MemoryDailyFeatures(),
    now: () => new Date('2026-10-01T09:00:00Z'),
  };
  const app = createApp(async () => deps, logger);
  const push = (path: string, payload: unknown) =>
    app.request(path, {
      method: 'POST',
      body: JSON.stringify(encodePushEnvelope(payload)),
      headers: { 'Content-Type': 'application/json' },
    });
  const task = (path: string, body: unknown) =>
    app.request(path, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    });
  return { lines, tasks, llm, push, task };
}

const reply =
  (out: unknown): Script =>
  () => ({ text: JSON.stringify(out) });
const notif = async (f: string, id: string) =>
  (await db.doc(`families/${f}/notifications/${id}`).get()).data() as NotificationDoc | undefined;

describe('writer validation', () => {
  it('does not mistake verbatim trusted facts for a quote, but still checks generated advice', () => {
    const childSummary = '落ち着いてお話を聞いてほしい';
    const rules = { banned: [], childSummary, facts: GOOD };
    expect(violations(GOOD, rules)).toEqual([]);
    expect(
      violations(
        { ...GOOD, suggestions: { ...GOOD.suggestions, try: [childSummary, '話せる時間を選ぶ'] } },
        rules,
      ),
    ).toContain('quote');
  });

  it.each([
    '一週間会話が減っているので、一緒に過ごす時間を作ってください',
    '元気のない日が続いています。声をかけてください',
    '会話が少ない傾向が見られます。話を聞いてください',
  ])('rejects observed-fact claims hidden in otherwise valid advice: %s', async (claim) => {
    expect(
      violations(
        { ...GOOD, suggestions: { ...GOOD.suggestions, try: [claim, '話せる時間を選ぶ'] } },
        {
          banned: [],
          childSummary: SUMMARY,
          facts: GOOD,
          adviceObservationPatterns: await loadAdviceObservationPatterns(kb),
        },
      ),
    ).toContain('unsupported_observation');
  });

  it('rejects any model alteration to factual fields, but permits personalized suggestions', () => {
    const rules = { banned: [], childSummary: SUMMARY, facts: GOOD };
    expect(
      violations(
        { ...GOOD, suggestions: { try: ['一緒に話す時間を選ぶ', '最後まで聞く'], avoid: [] } },
        rules,
      ),
    ).toEqual([]);
    for (const altered of [
      { title: '元気のない日が続いています' },
      { changes: ['会話が減りました'] },
      { meaning: '学校で無視されています' },
    ])
      expect(violations({ ...GOOD, ...altered }, rules)).toContain('unsupported_facts');
  });

  it('rejects banned words, quotes of the summary and empty fields', () => {
    const rules = { banned: ['うつ', 'いじめられている'], childSummary: SUMMARY };
    expect(violations(GOOD, rules)).toEqual([]);
    expect(violations({ ...GOOD, meaning: 'うつの可能性があります' }, rules)).toEqual(['banned']);
    expect(violations({ ...GOOD, changes: ['「無視されてつらい」と話しました'] }, rules)).toEqual([
      'quote',
    ]);
    expect(violations({ ...GOOD, title: ' ' }, rules)).toEqual(['empty']);
  });

  it('static fallback drops the change line when there is no basis', async () => {
    const raw = await loadTemplate(kb, 'care_hint');
    const withDays = staticCareHint(raw, 'はな', 7);
    expect(withDays.changes).toEqual(['記録上、この7日ほど、いつもと違う傾向が見られました。']);
    expect(withDays.suggestions).toEqual({
      try: ['「話したいときに聞くよ」と声をかける', '落ち着いて話せる時間を一緒に決める'],
      avoid: ['問い詰める', 'すぐに学校へ電話する'],
    });
    const none = staticCareHint(raw, 'はな', 0);
    expect(none.changes).toEqual([]);
    expect(none.title).toBe(GOOD.title);
    expect(none.meaning).toBe(GOOD.meaning);
    expect(JSON.stringify(none)).not.toContain('0日');
  });
});

describe('consultation.resolved', () => {
  it('proxy completes the care_hint with the verbatim summary (S3)', async () => {
    const [f, c] = ['f_nc1', 'c_nc1'];
    await seed(f, c, { id: 'cs1', level: 'l3', assessmentId: 'a1', choice: 'proxy' });
    await seedDraft(f, c, 'cs1');
    const t = setup(reply(GOOD));
    const ev = { childId: c, consultationId: 'cs1', choice: 'proxy' };
    expect((await t.push('/internal/events/consultation-resolved', ev)).status).toBe(204);

    const n = (await notif(f, careHintId(c, 'cs1')))!;
    expect(n).toMatchObject({
      kind: 'care_hint',
      recipientIds: ['g1', 'g2'],
      channels: ['webpush', 'email'],
      templateId: `prompts/notification_writer.md@${kb.version}`,
      payload: {
        ...GOOD,
        childSummary: SUMMARY,
        reason: { domains: ['a'], days: 0 },
        resources: [expect.objectContaining({ id: 'sos_dial' })],
      },
    });
    const consult = (await db.doc(`families/${f}/children/${c}/consultations/cs1`).get()).data()!;
    expect(consult['notificationId']).toBe(careHintId(c, 'cs1'));
    expect(t.tasks.take('notify-send')).toHaveLength(3);

    const req = JSON.stringify(t.llm.requests);
    expect(req).toContain('会話の様子');
    expect(req).not.toContain('1日ほど');
    expect(req).not.toContain(SENTINEL);
    expect(t.lines.join('\n')).not.toContain(SUMMARY);

    // 重複配信：モデルを再度呼び出さず、重ねて送信もしない
    expect((await t.push('/internal/events/consultation-resolved', ev)).status).toBe(204);
    expect(t.llm.requests).toHaveLength(1);
    expect(t.tasks.take('notify-send')).toEqual([]);
  });

  it('falls back to the static template after two invalid drafts', async () => {
    const [f, c] = ['f_nc2', 'c_nc2'];
    await seed(f, c, { id: 'cs2', level: 'l3', assessmentId: 'a1', choice: 'proxy' });
    await seedDraft(f, c, 'cs2');
    const t = setup(reply({ ...GOOD, changes: [`「${SUMMARY}」とのことです`] }));
    await t.push('/internal/events/consultation-resolved', {
      childId: c,
      consultationId: 'cs2',
      choice: 'proxy',
    });
    expect(t.llm.requests).toHaveLength(2);
    const n = (await notif(f, careHintId(c, 'cs2')))!;
    expect(n.templateId).toBe(`templates/notifications/care_hint.ja.md@${kb.version}`);
    expect(n.payload.title).toBe(GOOD.title);
    expect(n.payload.changes).toEqual([]);
    expect(n.payload.meaning).toBe(GOOD.meaning);
    expect(n.payload.childSummary).toBe(SUMMARY);
    expect(t.lines.some((l) => l.includes('notify.writer_fallback'))).toBe(true);
  });

  it.each([
    { name: 'missing assessment', assessmentId: 'child_initiated', days: 0 },
    { name: 'aggregate evidence', assessmentId: 'a1', days: 7 },
  ])('preserves the factual boundary for $name', async ({ name, assessmentId, days }) => {
    const suffix = days === 0 ? 'missing' : 'aggregate';
    const [f, c] = [`f_nc_${suffix}`, `c_nc_${suffix}`];
    await seed(f, c, { id: 'cs', level: 'l2', assessmentId, choice: 'proxy' });
    if (days > 0)
      await db.doc(`families/${f}/children/${c}/riskAssessments/a1`).set({
        level: 'l2',
        explanation: { domains: ['a'], days },
      });
    await seedDraft(f, c, 'cs');
    // Fluent but unsupported facts must never survive either model attempt.
    const t = setup(
      reply({ ...GOOD, title: '元気のない日が続いています', meaning: '学校で会話が減っています' }),
    );
    expect(
      (
        await t.push('/internal/events/consultation-resolved', {
          childId: c,
          consultationId: 'cs',
          choice: 'proxy',
        })
      ).status,
      name,
    ).toBe(204);
    const n = (await notif(f, careHintId(c, 'cs')))!;
    expect(n.payload.title).toBe(GOOD.title);
    expect(n.payload.meaning).toBe(GOOD.meaning);
    expect(n.payload.changes).toEqual(
      days ? ['記録上、この7日ほど、いつもと違う傾向が見られました。'] : [],
    );
    expect(n.payload.reason.days).toBe(days);
    expect(n.payload.childSummary).toBe(SUMMARY);
    expect(t.llm.requests).toHaveLength(2);
  });

  it('L3 not_now sends a content-free alert without the model (S4)', async () => {
    const [f, c] = ['f_nc3', 'c_nc3'];
    await seed(f, c, { id: 'cs3', level: 'l3', assessmentId: 'a1', choice: 'not_now' });
    const t = setup(reply(GOOD));
    await t.push('/internal/events/consultation-resolved', {
      childId: c,
      consultationId: 'cs3',
      choice: 'not_now',
    });
    const n = (await notif(f, contentFreeId(c, 'cs3')))!;
    expect(n).toMatchObject({
      kind: 'content_free_alert',
      recipientIds: ['g1', 'g2'],
      payload: { childSummary: null, reason: { domains: [], days: 0 } },
    });
    expect(n.payload.title).toBe('はなさんのことを、少し気にかけてあげてください');
    expect(t.llm.requests).toHaveLength(0);
    expect(t.tasks.take('notify-send')).toHaveLength(3);
  });

  it('L2 not_now and self send nothing', async () => {
    const [f, c] = ['f_nc4', 'c_nc4'];
    await seed(f, c, { id: 'cs4', level: 'l2', assessmentId: 'a1', choice: 'not_now' });
    const t = setup(reply(GOOD));
    await t.push('/internal/events/consultation-resolved', {
      childId: c,
      consultationId: 'cs4',
      choice: 'not_now',
    });
    await t.push('/internal/events/consultation-resolved', {
      childId: c,
      consultationId: 'cs4',
      choice: 'self',
    });
    expect((await db.collection(`families/${f}/notifications`).get()).size).toBe(0);
    expect(t.tasks.tasks).toEqual([]);
  });
});

describe('consultation-timeout task', () => {
  it('sends one content-free alert when an L3 consultation is unanswered', async () => {
    const [f, c] = ['f_nc5', 'c_nc5'];
    await seed(f, c, { id: 'cs5', level: 'l3', assessmentId: 'a1' });
    const t = setup(reply(GOOD));
    const body = { familyId: f, childId: c, consultationId: 'cs5' };
    expect((await t.task('/internal/tasks/consultation-timeout', body)).status).toBe(204);
    expect((await t.task('/internal/tasks/consultation-timeout', body)).status).toBe(204);
    expect((await notif(f, contentFreeId(c, 'cs5')))!.kind).toBe('content_free_alert');
    expect(t.tasks.take('notify-send')).toHaveLength(3);
  });

  it('does nothing once the child has answered', async () => {
    const [f, c] = ['f_nc6', 'c_nc6'];
    await seed(f, c, { id: 'cs6', level: 'l3', assessmentId: 'a1', choice: 'self' });
    const t = setup(reply(GOOD));
    const body = { familyId: f, childId: c, consultationId: 'cs6' };
    expect((await t.task('/internal/tasks/consultation-timeout', body)).status).toBe(204);
    expect((await db.collection(`families/${f}/notifications`).get()).size).toBe(0);
  });
});
