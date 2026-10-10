import { FieldValue, type Firestore, type Timestamp } from '@google-cloud/firestore';
import type { ContextCategory, Domain, GradeBand, RiskLevel } from '@ijime/api-types';
import {
  featuresSchema,
  holidaysSchema,
  riskRulesSchema,
  type FeatureDefinition,
  type RiskRules,
} from '@ijime/kb-loader';
import { ACTIVE_CRISIS_STATUSES, batch, isCrisisActive } from '@ijime/config';
import { inShard, stableId, type Shard } from '@ijime/service-kit';

import type { RiskEngineDeps } from '../deps.js';
import { RULES_PATH, respond } from '../event.js';
import { explicitL3, isHigher } from '../levels.js';
import { isScoredSignal, loadSignalDefs, scoringOf, type Scoring } from '../scoring.js';
import { childDocPath, commitAssessment, type ChildState } from '../store.js';
import { assess, type AssessOutput, type History } from './assess.js';
import { addDays, contextsOn, type ContextSpan } from './calendar.js';
import type {
  BaselineRow,
  DailyFeatureRow,
  FeatureStore,
  PartitionedTable,
  PartitionRows,
  RiskLevelRow,
} from './feature-store.js';
import { aggregateDay, contextFeatures, type SignalRow } from './features.js';

export const FEATURES_PATH = 'rules/features.yaml';
export const HOLIDAYS_PATH = 'resources/jp_holidays.yaml';

export type DailyJobDeps = RiskEngineDeps & { store: FeatureStore };

type DailyChild = ChildState & { pseudoId: string; gradeBand: GradeBand; createdAt?: Date };

type Prepared = {
  child: DailyChild;
  contexts: ContextSpan[];
  explicitDomains: Domain[];
  rows: DailyFeatureRow[];
};

export type DailyJobResult = { date: string; processed: number; failed: number; changed: number };

const toDate = (v: unknown): Date | undefined =>
  v ? (v instanceof Date ? v : (v as Timestamp).toDate()) : undefined;

async function listChildren(db: Firestore): Promise<DailyChild[]> {
  const snap = await db.collectionGroup('children').get();
  return snap.docs.flatMap((doc) => {
    const d = doc.data();
    if (!d['childId'] || !d['pseudoId'] || (d['status'] && d['status'] !== 'active')) return [];
    const out: DailyChild = {
      childId: d['childId'] as string,
      familyId: (d['familyId'] as string | undefined) ?? doc.ref.parent.parent!.id,
      currentRiskLevel: (d['currentRiskLevel'] as RiskLevel | undefined) ?? 'l0',
      pseudoId: d['pseudoId'] as string,
      gradeBand: d['gradeBand'] as GradeBand,
    };
    const ready = toDate(d['baselineReadyAt']);
    if (ready) out.baselineReadyAt = ready;
    const created = toDate(d['createdAt']);
    if (created) out.createdAt = created;
    return [out];
  });
}

async function prepare(
  deps: DailyJobDeps,
  child: DailyChild,
  date: string,
  windowFrom: string,
  defs: readonly FeatureDefinition[],
  rules: RiskRules,
  scoring: Scoring,
): Promise<Prepared> {
  const base = childDocPath(child.familyId, child.childId);
  const [signalSnap, ctxSnap] = await Promise.all([
    deps.db.collection(`${base}/signals`).where('localDate', '==', date).get(),
    // レベル判定の窓と重なるコンテキスト情報だけを取る：終了済みの古いものはクエリで、未開始のものはメモリ上で除外する
    deps.db
      .collection(`families/${child.familyId}/contextEvents`)
      .where('childIds', 'array-contains', child.childId)
      .where('endDate', '>=', windowFrom)
      .get(),
  ]);
  const signals = signalSnap.docs.map(
    (d) => d.data() as SignalRow & { explicit?: boolean; signalDefId: string },
  );
  const contexts = ctxSnap.docs.flatMap((d) => {
    const c = d.data();
    const span = {
      category: c['category'] as ContextCategory,
      startDate: c['startDate'] as string,
      endDate: c['endDate'] as string,
    };
    return span.startDate <= date ? [span] : [];
  });
  const features = [
    ...aggregateDay(signals, defs, scoring),
    ...contextFeatures(contextsOn(date, contexts)),
  ];
  const explicit = explicitL3(
    signals
      .filter((s) => s.explicit && isScoredSignal(s, scoring))
      .map((s) => ({ domain: s.domain, signalDefId: s.signalDefId })),
    rules,
  );
  return {
    child,
    contexts,
    explicitDomains: explicit.domains,
    rows: features.map((f) => ({
      pseudo_id: child.pseudoId,
      feature_date: date,
      domain: f.domain,
      feature_name: f.name,
      value: f.value,
      grade_band: child.gradeBand,
      kb_version: deps.kb.version,
    })),
  };
}

function historyOf(rows: readonly DailyFeatureRow[]): Map<string, Map<string, History>> {
  const byChild = new Map<string, Map<string, Map<string, number>>>();
  for (const r of rows) {
    const days = byChild.get(r.pseudo_id) ?? new Map<string, Map<string, number>>();
    const day = days.get(r.feature_date) ?? new Map<string, number>();
    day.set(r.feature_name, r.value);
    days.set(r.feature_date, day);
    byChild.set(r.pseudo_id, days);
  }
  return byChild as unknown as Map<string, Map<string, History>>;
}

// レベルを下げるときの維持ルール：危機がクローズされるまでは L4 を保つ。L3 の相談が未回答の間は L3 を保つ
async function holdLevel(
  deps: DailyJobDeps,
  child: DailyChild,
  computed: RiskLevel,
  rules: RiskRules,
): Promise<RiskLevel> {
  if (!isHigher(child.currentRiskLevel, computed)) return computed;
  const base = childDocPath(child.familyId, child.childId);
  if (child.currentRiskLevel === 'l4') {
    const open = await deps.db
      .collection(`${base}/crisisEvents`)
      .where('status', 'in', ACTIVE_CRISIS_STATUSES)
      .get();
    const now = deps.now();
    if (open.docs.some((d) => isCrisisActive(d.data(), now))) return 'l4';
  }
  if (
    rules.daily.hold_l3_until_consultation_resolved &&
    (child.currentRiskLevel === 'l3' || child.currentRiskLevel === 'l4')
  ) {
    const recent = await deps.db
      .collection(`${base}/consultations`)
      .orderBy('offeredAt', 'desc')
      .limit(10)
      .get();
    const pending = recent.docs.some((d) => {
      const c = d.data();
      return !c['choice'] && c['level'] === 'l3';
    });
    if (pending) return 'l3';
  }
  return computed;
}

// 保護者または子どもの確認から 24 時間経った危機イベント、家庭内の危害の類型は検知から 7 日経ったイベントを closed にする（2026-10-10 決定）。
// 読み取り側はすでに同じルールで判断しているので、ここでは状態をデータに落とし、L4 の解除と後続の集計に根拠を残すだけ。
async function closeExpiredCrises(deps: DailyJobDeps, child: DailyChild, now: Date) {
  const base = childDocPath(child.familyId, child.childId);
  const candidates = await deps.db
    .collection(`${base}/crisisEvents`)
    .where('status', 'in', ACTIVE_CRISIS_STATUSES)
    .get();
  const expired = candidates.docs.filter((d) => !isCrisisActive(d.data(), now));
  for (const doc of expired) {
    await deps.db.runTransaction(async (tx) => {
      const current = await tx.get(doc.ref);
      if (current.get('status') === 'closed' || isCrisisActive(current.data() ?? {}, now)) return;
      tx.update(doc.ref, {
        status: 'closed',
        timeline: FieldValue.arrayUnion({ step: 'closed', at: now }),
      });
    });
  }
  if (expired.length > 0)
    deps.logger.info('crisis.auto_closed', { pseudoId: child.pseudoId, count: expired.length });
}

async function applyLevel(
  deps: DailyJobDeps,
  child: DailyChild,
  date: string,
  out: AssessOutput,
  rules: RiskRules,
  inColdStart: boolean,
): Promise<{ level: RiskLevel; domains: Domain[] }> {
  const level = await holdLevel(deps, child, out.level, rules);
  const assessmentId = `daily-${stableId(child.childId, date)}`;
  const held = level !== out.level;
  const domains = held ? [] : out.domainsFlagged;
  const result = await commitAssessment(
    deps.db,
    child,
    assessmentId,
    {
      level,
      trigger: 'daily',
      domainsFlagged: domains,
      persistenceDays: out.persistenceDays,
      inColdStart,
      rulesVersion: deps.kb.version,
      explanation: held ? { domains: [], days: 0 } : out.explanation,
      computedAt: deps.now(),
    },
    level === 'l2' || level === 'l3'
      ? { consultationId: `consult-${stableId(assessmentId)}`, now: deps.now() }
      : undefined,
  );
  await respond(deps, child, assessmentId, level, result);
  if (result.previousLevel !== level) {
    deps.logger.warn('risk.level_changed', {
      assessmentId,
      from: result.previousLevel,
      to: level,
      trigger: 'daily',
    });
  }
  return { level, domains };
}

export const JOB_RUNS = 'jobRuns';

// 異常検知は、すべてのシャードがその日の daily_features を書き終えてから実行する。集合を完成させたシャードが実行を担当する。
// 同じ task のリトライでは index が同じなので、二重に数えることはない
async function lastShardDone(
  deps: DailyJobDeps,
  date: string,
  shard: Shard,
  executionId: string,
): Promise<boolean> {
  const ref = deps.db.doc(`${JOB_RUNS}/daily-${stableId(date, executionId)}`);
  return deps.db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const done = new Set<number>((snap.get('doneTasks') as number[] | undefined) ?? []);
    done.add(shard.index);
    const complete = done.size >= shard.count && !snap.get('anomaliesStartedAt');
    tx.set(
      ref,
      {
        job: 'risk-engine-daily',
        date,
        taskCount: shard.count,
        doneTasks: [...done].sort((a, b) => a - b),
        ...(complete ? { anomaliesStartedAt: deps.now() } : {}),
        expiresAt: new Date(deps.now().getTime() + batch.jobRunTtlDays * 86_400_000),
      },
      { merge: true },
    );
    return complete;
  });
}

export type DailyJobOptions = { shard?: Shard; executionId?: string };

// 日次ジョブ：date 当日の signals を集計 → daily_features に書き込み → 履歴を読み込み → レベル判定 → 書き戻し。
// シャード分割時は各 task が inShard の子どもだけを処理し、BigQuery ではその子どもたちの行だけを置き換える
export async function runDailyJob(
  deps: DailyJobDeps,
  date: string,
  opts: DailyJobOptions = {},
): Promise<DailyJobResult> {
  const shard = opts.shard ?? { index: 0, count: 1 };
  const sharded = shard.count > 1;
  const { kb, logger, store } = deps;
  const rules = await kb.yaml(RULES_PATH, riskRulesSchema);
  const defs = (await kb.yaml(FEATURES_PATH, featuresSchema)).features;
  const scoring = scoringOf(await loadSignalDefs(kb));
  const scoredDefs = defs.filter(scoring.scored);
  const holidays = new Set(
    (await kb.yaml(HOLIDAYS_PATH, holidaysSchema)).holidays.map((h) => h.date),
  );

  const from = addDays(
    date,
    -(rules.daily.baseline.window_days + rules.daily.persistence.lookback_days),
  );
  const children = (await listChildren(deps.db)).filter((c) => inShard(c.childId, shard));
  const shardIds = children.map((c) => c.pseudoId);
  const write = <T extends PartitionedTable>(table: T, rows: PartitionRows[T]) =>
    sharded
      ? store.replaceRows(table, date, shardIds, rows)
      : store.writePartition(table, date, rows);
  const prepared: Prepared[] = [];
  let failed = 0;
  for (const child of children) {
    try {
      prepared.push(await prepare(deps, child, date, from, defs, rules, scoring));
    } catch (err) {
      failed++;
      logger.error('daily.prepare_failed', {
        pseudoId: child.pseudoId,
        error: err instanceof Error ? err : new Error('unknown'),
      });
    }
  }

  await write(
    'daily_features',
    prepared.flatMap((p) => p.rows),
  );

  const history = historyOf(
    await store.readDailyFeatures(
      prepared.map((p) => p.child.pseudoId),
      from,
      date,
    ),
  );

  const baselines: BaselineRow[] = [];
  const levels: RiskLevelRow[] = [];
  let changed = 0;
  const now = deps.now();
  for (const p of prepared) {
    const { child } = p;
    try {
      const readyAt =
        child.baselineReadyAt ??
        (child.createdAt
          ? new Date(child.createdAt.getTime() + rules.cold_start_days * 86_400_000)
          : undefined);
      const cold = !readyAt || readyAt.getTime() > now.getTime();
      const out = assess({
        date,
        history: (history.get(child.pseudoId) ?? new Map()) as History,
        contexts: p.contexts,
        holidays,
        features: scoredDefs,
        rules,
        inColdStart: cold,
        explicitDomains: p.explicitDomains,
      });
      if (!child.baselineReadyAt && readyAt) {
        await deps.db.doc(childDocPath(child.familyId, child.childId)).update({
          baselineReadyAt: readyAt,
        });
      }
      await closeExpiredCrises(deps, child, now);
      const { level, domains } = await applyLevel(deps, child, date, out, rules, cold);
      if (level !== child.currentRiskLevel) changed++;
      for (const b of out.baselines) {
        baselines.push({
          pseudo_id: child.pseudoId,
          feature_name: b.feature,
          day_type: b.dayType,
          median: b.median,
          iqr: b.iqr,
          window_days: rules.daily.baseline.window_days,
          // computed_at には特徴の日付を使う。再実行では同じパーティションを上書きする
          computed_at: `${date}T00:00:00Z`,
        });
      }
      levels.push({
        pseudo_id: child.pseudoId,
        date,
        level,
        domains_flagged: domains,
        rules_version: kb.version,
      });
    } catch (err) {
      failed++;
      logger.error('daily.assess_failed', {
        pseudoId: child.pseudoId,
        error: err instanceof Error ? err : new Error('unknown'),
      });
    }
  }

  await write('baselines', baselines);
  await write('risk_levels_daily', levels);

  try {
    const runAnomalies =
      !sharded || (await lastShardDone(deps, date, shard, opts.executionId ?? 'local'));
    if (runAnomalies) {
      await store.refreshAnomalies(date, {
        retrain: new Date(`${date}T00:00:00Z`).getUTCDay() === 0,
        threshold: rules.daily.anomaly_prob_threshold,
        modelVersion: `arima_plus@${kb.version}`,
      });
    }
  } catch (err) {
    logger.warn('daily.anomalies_failed', {
      error: err instanceof Error ? err : new Error('unknown'),
    });
  }

  const result = { date, processed: levels.length, failed, changed };
  logger.info('daily.done', { ...result, taskIndex: shard.index, taskCount: shard.count });
  return result;
}
