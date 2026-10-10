import type { GradeBand, MoodWeather } from '@ijime/api-types';
import { MOOD_WEATHERS } from '@ijime/api-types';
import { batch, weeklyReport as rules } from '@ijime/config';
import { moodScoresSchema, weeklyReportSentencesSchema, type MoodScores } from '@ijime/kb-loader';
import { inShard, stableId, type Shard } from '@ijime/service-kit';
import { z } from 'zod';

import { enqueueSends } from './delivery.js';
import { loadTemplate, templateId, type NotifierDeps } from './deps.js';
import { channelsOf, planDeliveries } from './recipients.js';
import {
  childDocPath,
  createNotification,
  listGuardians,
  notificationPath,
  type NotificationDoc,
} from './store.js';
import { fillTemplate } from './templates.js';
import type { DailyFeatureRow } from './weekly-source.js';

export const WEEKLY_REPORT_PATH = '/internal/jobs/weekly-report';

// Cloud Scheduler が毎週月曜 07:00 に呼び出す。weekStart は特定の週を再実行するときに使う（月曜の日付）。
// shard を持たないリクエストはファンアウトだけを担当する：シャードごとに Cloud Task を1つ同じパスへ投げ、子ども ID のハッシュで分割する
export const weeklyJobSchema = z
  .strictObject({
    weekStart: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    shard: z.int().min(0).optional(),
    shardCount: z.int().min(1).max(50).optional(),
  })
  .refine(
    (j) =>
      (j.shard === undefined) === (j.shardCount === undefined) &&
      (j.shard === undefined || j.shard < j.shardCount!),
  );
export type WeeklyJob = z.infer<typeof weeklyJobSchema>;

export type Vitality = {
  mood: Record<MoodWeather, number>;
  activeDays: number;
  lateNightDays: number;
};

const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (date: string, n: number) =>
  iso(new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY));

// 日本時間での「先週」（月曜から日曜）
export function previousWeek(now: Date): { weekStart: string; weekEnd: string } {
  const jst = new Date(now.getTime() + 9 * 3_600_000);
  const dow = (jst.getUTCDay() + 6) % 7;
  const weekStart = addDays(iso(jst), -dow - 7);
  return { weekStart, weekEnd: addDays(weekStart, 6) };
}

// ISO 週：その週の木曜が属する年
export function isoWeekId(monday: string): string {
  const thursday = new Date(Date.parse(`${monday}T00:00:00Z`) + 3 * DAY);
  const year = thursday.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const week1Monday = jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * DAY;
  const week = Math.floor((thursday.getTime() - week1Monday) / (7 * DAY)) + 1;
  return `${year}-W${String(week).padStart(2, '0')}`;
}

// その日の気分：当日の m_mood_mean を四捨五入し、kb の対応表で天気に戻す
function weatherOf(mean: number, scores: MoodScores): MoodWeather {
  const target = Math.round(mean);
  let best: MoodWeather = MOOD_WEATHERS[0];
  for (const w of MOOD_WEATHERS)
    if (Math.abs(scores[w] - target) < Math.abs(scores[best] - target)) best = w;
  return best;
}

export function vitalityOf(rows: readonly DailyFeatureRow[], scores: MoodScores): Vitality {
  const mood = Object.fromEntries(MOOD_WEATHERS.map((w) => [w, 0])) as Record<MoodWeather, number>;
  const active = new Set<string>();
  const lateNight = new Set<string>();
  for (const r of rows) {
    // コンテキスト情報の特徴（x 領域）は保護者の登録に由来し、子どもが使ったことを示さない
    if (r.domain === 'x') continue;
    active.add(r.feature_date);
    if (r.feature_name === 'i_late_night_count' && r.value > 0) lateNight.add(r.feature_date);
    if (r.feature_name === 'm_mood_mean') mood[weatherOf(r.value, scores)]++;
  }
  return { mood, activeDays: active.size, lateNightDays: lateNight.size };
}

type Condition = 'low_activity' | 'low_mood_days' | 'late_night_days' | 'stable_days';

// docs/02-agent-architecture.md「通知文の作成と週次レポート」：順に見て、最初に当てはまった2件を採用する
export function summarize(
  v: Vitality,
  sentences: readonly { condition: Condition; text_ja: string }[],
): string {
  const hit: Record<Condition, boolean> = {
    low_activity: v.activeDays <= rules.lowActivityMaxDays,
    low_mood_days: v.mood.rainy + v.mood.stormy >= rules.lowMoodMinDays,
    late_night_days: v.lateNightDays >= rules.lateNightMinDays,
    stable_days: v.mood.sunny + v.mood.cloudy >= rules.stableMinDays,
  };
  return sentences
    .filter((s) => hit[s.condition])
    .slice(0, rules.maxSummarySentences)
    .map((s) => s.text_ja)
    .join('');
}

type ReportChild = {
  childId: string;
  familyId: string;
  nickname: string;
  gradeBand: GradeBand;
  pseudoId: string;
};

async function listActiveChildren(deps: NotifierDeps): Promise<ReportChild[]> {
  const snap = await deps.db.collectionGroup('children').get();
  return snap.docs.flatMap((doc) => {
    const d = doc.data();
    if (!d['childId'] || !d['pseudoId'] || (d['status'] && d['status'] !== 'active')) return [];
    return [
      {
        childId: d['childId'] as string,
        familyId: (d['familyId'] as string | undefined) ?? doc.ref.parent.parent!.id,
        nickname: (d['nickname'] as string | undefined) ?? '',
        gradeBand: d['gradeBand'] as GradeBand,
        pseudoId: d['pseudoId'] as string,
      },
    ];
  });
}

export const weeklyNotificationId = (childId: string, weekId: string) =>
  `weekly-${stableId(childId, weekId)}`;

export async function runWeeklyReport(deps: NotifierDeps, job: WeeklyJob): Promise<void> {
  const weekStart = job.weekStart ?? previousWeek(deps.now()).weekStart;
  if (job.shard !== undefined)
    return runWeeklyShard(deps, weekStart, { index: job.shard, count: job.shardCount! });
  const count = batch.weeklyReportShards;
  if (count <= 1) return runWeeklyShard(deps, weekStart, { index: 0, count: 1 });
  const weekId = isoWeekId(weekStart);
  for (let index = 0; index < count; index++) {
    const body: WeeklyJob = { weekStart, shard: index, shardCount: count };
    // 定時実行では決定論的なタスク名を使い、Scheduler のリトライでファンアウトが重複しないようにする。weekStart 指定の再実行ではタスク名を付けない。
    // 付けると、実行済みタスク名に対する Cloud Tasks の重複排除に引っかかるため。シャードの再実行自体は冪等
    await deps.tasks.enqueue({
      queue: 'weekly-report',
      url: `${deps.selfUrl}${WEEKLY_REPORT_PATH}`,
      body,
      ...(job.weekStart ? {} : { taskId: `weekly-${stableId(weekId, index, count)}` }),
    });
  }
  deps.logger.info('notify.weekly_report_fanout', { weekId, shards: count });
}

// 週次レポートはモデルを経由しない：元気度は daily_features から計算し、ひとこと解説は kb のテンプレートからルールで選ぶ
async function runWeeklyShard(deps: NotifierDeps, weekStart: string, shard: Shard): Promise<void> {
  const { db, kb, logger } = deps;
  const weekEnd = addDays(weekStart, 6);
  const weekId = isoWeekId(weekStart);
  const children = (await listActiveChildren(deps)).filter((c) => inShard(c.childId, shard));
  const rows = await deps.features.read(
    children.map((c) => c.pseudoId),
    weekStart,
    weekEnd,
  );
  const byPseudo = new Map<string, DailyFeatureRow[]>();
  for (const r of rows) byPseudo.set(r.pseudo_id, [...(byPseudo.get(r.pseudo_id) ?? []), r]);
  const { scores } = await kb.yaml('rules/mood_scores.yaml', moodScoresSchema);
  const { sentences } = await kb.yaml(
    'templates/weekly_report.ja.yaml',
    weeklyReportSentencesSchema,
  );
  const template = await loadTemplate(kb, 'weekly_report');

  let failed = 0;
  for (const child of children) {
    try {
      const vitality = vitalityOf(byPseudo.get(child.pseudoId) ?? [], scores);
      const summaryText = summarize(vitality, sentences);
      await db
        .doc(`${childDocPath(child.familyId, child.childId)}/weeklyReports/${weekId}`)
        .set({ weekStart, vitality, summaryText, generatedAt: deps.now() }, { merge: true });

      const deliveries = planDeliveries('weekly_report', await listGuardians(db, child.familyId));
      const t = fillTemplate(template, { nickname: child.nickname });
      const notificationId = weeklyNotificationId(child.childId, weekId);
      const doc: NotificationDoc = {
        childId: child.childId,
        recipientIds: deliveries.map((d) => d.guardianId),
        kind: 'weekly_report',
        // 週次レポートはリスクと無関係。保護者側のエンドポイントは level を返さない
        level: 'l0',
        templateId: templateId(kb, 'weekly_report'),
        payload: {
          title: t.title,
          changes: [],
          meaning: summaryText,
          suggestions: { try: [], avoid: [] },
          childSummary: null,
          resources: [],
          reason: { domains: [], days: 0 },
        },
        channels: channelsOf(deliveries),
        status: 'queued',
        attempts: [],
        createdAt: deps.now(),
      };
      const created = await createNotification(db, child.familyId, notificationId, doc);
      // 再実行では、送信の試行記録がまだない通知だけを送る（タスク ID が決定論的なので、重複した登録は Cloud Tasks が拒否する）
      const pending =
        created ||
        (
          (await db.doc(notificationPath(child.familyId, notificationId)).get()).get('attempts') ??
          []
        ).length === 0;
      const sends = pending
        ? await enqueueSends(deps, child.familyId, notificationId, deliveries, 0)
        : 0;
      logger.info('notify.weekly_report', {
        notificationId,
        weekId,
        activeDays: vitality.activeDays,
        sends,
      });
    } catch (err) {
      failed++;
      logger.error('notify.weekly_report_failed', {
        weekId,
        error: err instanceof Error ? err : new Error('unknown'),
      });
    }
  }
  logger.info('notify.weekly_report_done', {
    weekId,
    shard: shard.index,
    shardCount: shard.count,
    children: children.length,
    failed,
  });
  // 失敗があればこのシャードを Cloud Tasks にリトライさせる。作成済みの週次レポートは上書きされ、通知は決定論的な ID により重複しない
  if (failed > 0) throw new Error(`weekly report failed for ${failed} children`);
}
