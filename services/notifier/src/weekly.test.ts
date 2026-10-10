import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Firestore } from '@google-cloud/firestore';
import { FsKbSource, Kb, weeklyReportSentencesSchema } from '@ijime/kb-loader';
import { batch } from '@ijime/config';
import { Logger, MemoryTaskQueue, shardOf } from '@ijime/service-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { LogOnlySender, MemorySender } from './channels.js';
import { SEND_TASK_PATH } from './delivery.js';
import type { NotifierDeps } from './deps.js';
import type { NotificationDoc } from './store.js';
import {
  isoWeekId,
  previousWeek,
  summarize,
  vitalityOf,
  weeklyNotificationId,
  WEEKLY_REPORT_PATH,
  type Vitality,
} from './weekly.js';
import { MemoryDailyFeatures, type DailyFeatureRow } from './weekly-source.js';

const KB_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../kb/v0.1.0');
const SCORES = { sunny: 3, cloudy: 2, rainy: 1, stormy: 0 };

let kb: Kb;
let sentences: Awaited<ReturnType<typeof loadSentences>>;
const loadSentences = async () =>
  (await kb.yaml('templates/weekly_report.ja.yaml', weeklyReportSentencesSchema)).sentences;

const row = (
  pseudo: string,
  date: string,
  name: string,
  value: number,
  domain = name[0]!,
): DailyFeatureRow => ({
  pseudo_id: pseudo,
  feature_date: date,
  domain,
  feature_name: name,
  value,
});

const vit = (mood: Partial<Vitality['mood']>, activeDays: number, lateNightDays = 0): Vitality => ({
  mood: { sunny: 0, cloudy: 0, rainy: 0, stormy: 0, ...mood },
  activeDays,
  lateNightDays,
});

describe('weekly report rules', () => {
  beforeAll(async () => {
    kb = await Kb.load(new FsKbSource(KB_DIR));
    sentences = await loadSentences();
  });

  it('picks last week in Japan time and names it by ISO week', () => {
    // 2026-10-05（月曜）の 07:00 JST
    expect(previousWeek(new Date('2026-10-04T22:00:00Z'))).toEqual({
      weekStart: '2026-09-28',
      weekEnd: '2026-10-04',
    });
    // 日曜深夜（UTC ではすでに月曜）も今週に含める
    expect(previousWeek(new Date('2026-10-04T14:00:00Z')).weekStart).toBe('2026-09-21');
    expect(isoWeekId('2026-09-28')).toBe('2026-W40');
    expect(isoWeekId('2026-12-28')).toBe('2026-W53');
    expect(isoWeekId('2027-01-04')).toBe('2027-W01');
  });

  it('counts mood days, active days and late-night days from daily features', () => {
    const rows = [
      row('p', '2026-09-28', 'm_mood_mean', 3),
      row('p', '2026-09-29', 'm_mood_mean', 1.4),
      row('p', '2026-09-30', 'm_mood_mean', 0.5),
      row('p', '2026-09-30', 'i_late_night_count', 2),
      row('p', '2026-10-01', 'i_late_night_count', 0),
      row('p', '2026-10-01', 'i_message_count', 4),
      row('p', '2026-10-03', 'x_exam_flag', 1, 'x'),
    ];
    expect(vitalityOf(rows, SCORES)).toEqual({
      mood: { sunny: 1, cloudy: 0, rainy: 2, stormy: 0 },
      activeDays: 4,
      lateNightDays: 1,
    });
  });

  it('applies the thresholds at their boundaries and keeps the first two hits', () => {
    expect(summarize(vit({}, 2), sentences)).toBe('今週はあまり使いませんでした。');
    expect(summarize(vit({}, 3), sentences)).toBe('');
    expect(summarize(vit({ rainy: 2, stormy: 1 }, 3), sentences)).toBe(
      '今週は気分の落ちこむ日が少し多めでした。',
    );
    expect(summarize(vit({ rainy: 2 }, 3, 2), sentences)).toBe('');
    expect(summarize(vit({ sunny: 4, cloudy: 1 }, 6, 3), sentences)).toBe(
      '夜遅くに使う日が続きました。今週はおおむね安定していました。',
    );
    expect(summarize(vit({ stormy: 3 }, 2, 3), sentences)).toBe(
      '今週はあまり使いませんでした。今週は気分の落ちこむ日が少し多めでした。',
    );
  });
});

describe('weekly report job', () => {
  let db: Firestore;

  beforeAll(async () => {
    if (!process.env['FIRESTORE_EMULATOR_HOST']) throw new Error('needs Firestore emulator');
    // 週次レポートのジョブは子ども全員を走査する。並列で動くほかのテストファイルと分離するため、専用のプロジェクト ID を使う
    db = new Firestore({ projectId: 'demo-ijime-weekly' });
    kb ??= await Kb.load(new FsKbSource(KB_DIR));
  });
  afterAll(() => db.terminate());

  it('writes the report, queues a fixed-template notification once, and pushes the weekly copy', async () => {
    const f = 'f_weekly1';
    const c = 'c_weekly1';
    await db.doc(`families/${f}/children/${c}`).set({
      childId: c,
      familyId: f,
      nickname: 'はな',
      gradeBand: 'high',
      pseudoId: 'p_weekly1',
      status: 'active',
    });
    await db.doc(`families/${f}/guardians/g1`).set({ notifyChannels: ['webpush', 'email'] });
    await db
      .doc(`families/${f}/devices/d1`)
      .set({ ownerType: 'guardian', ownerId: 'g1', fcmToken: 'tok-w1', lastSeenAt: new Date() });

    const rows = ['2026-09-28', '2026-09-29', '2026-09-30'].flatMap((d) => [
      row('p_weekly1', d, 'm_mood_mean', 1),
      row('p_weekly1', d, 'i_message_count', 3),
    ]);
    rows.push(row('p_weekly1', '2026-10-05', 'm_mood_mean', 3));
    rows.push(row('p_other', '2026-09-28', 'm_mood_mean', 3));

    const lines: string[] = [];
    const logger = new Logger('notifier', (l) => lines.push(l));
    const tasks = new MemoryTaskQueue();
    const webpush = new MemorySender();
    const deps: NotifierDeps = {
      db,
      kb,
      model: 'unused',
      tasks,
      senders: {
        webpush,
        email: new LogOnlySender('email', logger),
        sms: new LogOnlySender('sms', logger),
      },
      logger,
      selfUrl: 'http://notifier.test',
      features: new MemoryDailyFeatures(rows),
      now: () => new Date('2026-10-04T22:00:00Z'),
    };
    const app = createApp(async () => deps, logger);
    const post = (path: string, body: unknown) =>
      app.request(path, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
      });

    // Scheduler からの呼び出しはシャードタスクをファンアウトするだけ。シャードは1つずつ実行する
    const runWeekly = async (body: unknown) => {
      expect((await post(WEEKLY_REPORT_PATH, body)).status).toBe(204);
      const shards = tasks.take('weekly-report');
      expect(shards.map((t) => t.url)).toEqual(
        Array(batch.weeklyReportShards).fill(`http://notifier.test${WEEKLY_REPORT_PATH}`),
      );
      for (const t of shards) expect((await post(WEEKLY_REPORT_PATH, t.body)).status).toBe(204);
    };
    await runWeekly({});

    const report = (
      await db.doc(`families/${f}/children/${c}/weeklyReports/2026-W40`).get()
    ).data()!;
    expect(report).toMatchObject({
      weekStart: '2026-09-28',
      vitality: {
        mood: { sunny: 0, cloudy: 0, rainy: 3, stormy: 0 },
        activeDays: 3,
        lateNightDays: 0,
      },
      summaryText: '今週は気分の落ちこむ日が少し多めでした。',
    });

    const id = weeklyNotificationId(c, '2026-W40');
    const notif = (
      await db.doc(`families/${f}/notifications/${id}`).get()
    ).data() as NotificationDoc;
    expect(notif).toMatchObject({
      kind: 'weekly_report',
      recipientIds: ['g1'],
      channels: ['webpush'],
      templateId: 'templates/notifications/weekly_report.ja.md@0.1.0',
      payload: {
        title: 'はなさんの今週のようす',
        meaning: '今週は気分の落ちこむ日が少し多めでした。',
        changes: [],
        resources: [],
      },
    });
    const mine = tasks.tasks.filter(
      (t) => (t.body as { notificationId: string }).notificationId === id,
    );
    expect(mine).toHaveLength(1);

    // 同じ週の再実行：通知もタスクも重複しない
    await runWeekly({ weekStart: '2026-09-28' });
    expect(
      tasks.tasks.filter((t) => (t.body as { notificationId: string }).notificationId === id),
    ).toHaveLength(1);

    expect((await post(SEND_TASK_PATH, mine[0]!.body)).status).toBe(204);
    expect(webpush.sent.at(-1)!.msg).toMatchObject({
      notificationId: id,
      pushTitle: '今週のようす',
      pushBody: '今週の元気度が届きました。アプリで確認してください。',
    });
    expect(lines.join('\n')).not.toContain('はな');
  });

  it('a shard only reports on the children that hash into it', async () => {
    const ids = Array.from({ length: 8 }, (_, i) => `c_wshard${i}`);
    for (const c of ids) {
      await db.doc(`families/f_${c}/children/${c}`).set({
        childId: c,
        familyId: `f_${c}`,
        nickname: 'はな',
        gradeBand: 'high',
        pseudoId: `p_${c}`,
        status: 'active',
      });
    }
    const logger = new Logger('notifier', () => undefined);
    const deps: NotifierDeps = {
      db,
      kb,
      model: 'unused',
      tasks: new MemoryTaskQueue(),
      senders: {
        webpush: new MemorySender(),
        email: new LogOnlySender('email', logger),
        sms: new LogOnlySender('sms', logger),
      },
      logger,
      selfUrl: 'http://notifier.test',
      features: new MemoryDailyFeatures([]),
      now: () => new Date('2026-10-04T22:00:00Z'),
    };
    const app = createApp(async () => deps, logger);
    const res = await app.request(WEEKLY_REPORT_PATH, {
      method: 'POST',
      body: JSON.stringify({ weekStart: '2026-09-21', shard: 1, shardCount: 3 }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(204);
    for (const c of ids) {
      const report = await db.doc(`families/f_${c}/children/${c}/weeklyReports/2026-W39`).get();
      expect(report.exists, c).toBe(shardOf(c, 3) === 1);
    }

    // シャード番号が範囲外のタスクは不正なペイロードとして捨てる（204、リトライなし）。ファンアウトにフォールバックはしない
    const bad = await app.request(WEEKLY_REPORT_PATH, {
      method: 'POST',
      body: JSON.stringify({ shard: 3, shardCount: 3 }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(bad.status).toBe(204);
    expect((deps.tasks as MemoryTaskQueue).tasks).toEqual([]);
  });
});
