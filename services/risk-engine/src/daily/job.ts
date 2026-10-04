import type { Firestore, Timestamp } from '@google-cloud/firestore';
import type { ContextCategory, Domain, GradeBand, RiskLevel } from '@ijime/api-types';
import {
  featuresSchema,
  holidaysSchema,
  riskRulesSchema,
  type FeatureDefinition,
  type RiskRules,
} from '@ijime/kb-loader';
import { stableId } from '@ijime/service-kit';

import type { RiskEngineDeps } from '../deps.js';
import { RULES_PATH, respond } from '../event.js';
import { explicitL3, isHigher } from '../levels.js';
import { childDocPath, commitAssessment, type ChildState } from '../store.js';
import { assess, type AssessOutput, type History } from './assess.js';
import { addDays, contextsOn, type ContextSpan } from './calendar.js';
import type { DailyFeatureRow, FeatureStore, RiskLevelRow, BaselineRow } from './feature-store.js';
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
  defs: readonly FeatureDefinition[],
  rules: RiskRules,
): Promise<Prepared> {
  const base = childDocPath(child.familyId, child.childId);
  const [signalSnap, ctxSnap] = await Promise.all([
    deps.db.collection(`${base}/signals`).where('localDate', '==', date).get(),
    deps.db
      .collection(`families/${child.familyId}/contextEvents`)
      .where('childIds', 'array-contains', child.childId)
      .get(),
  ]);
  const signals = signalSnap.docs.map(
    (d) => d.data() as SignalRow & { explicit?: boolean; signalDefId: string },
  );
  const contexts = ctxSnap.docs.map((d) => {
    const c = d.data();
    return {
      category: c['category'] as ContextCategory,
      startDate: c['startDate'] as string,
      endDate: c['endDate'] as string,
    };
  });
  const features = [...aggregateDay(signals, defs), ...contextFeatures(contextsOn(date, contexts))];
  const explicit = explicitL3(
    signals
      .filter((s) => s.explicit)
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
      .where('status', 'in', ['open', 'guardian_acknowledged'])
      .limit(1)
      .get();
    if (!open.empty) return 'l4';
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

// 日次ジョブ：date 当日の signals を集計 → daily_features に書き込み → 履歴を読み込み → レベル判定 → 書き戻し
export async function runDailyJob(deps: DailyJobDeps, date: string): Promise<DailyJobResult> {
  const { kb, logger, store } = deps;
  const rules = await kb.yaml(RULES_PATH, riskRulesSchema);
  const defs = (await kb.yaml(FEATURES_PATH, featuresSchema)).features;
  const holidays = new Set(
    (await kb.yaml(HOLIDAYS_PATH, holidaysSchema)).holidays.map((h) => h.date),
  );

  const children = await listChildren(deps.db);
  const prepared: Prepared[] = [];
  let failed = 0;
  for (const child of children) {
    try {
      prepared.push(await prepare(deps, child, date, defs, rules));
    } catch (err) {
      failed++;
      logger.error('daily.prepare_failed', {
        pseudoId: child.pseudoId,
        error: err instanceof Error ? err : new Error('unknown'),
      });
    }
  }

  await store.writePartition(
    'daily_features',
    date,
    prepared.flatMap((p) => p.rows),
  );

  const from = addDays(
    date,
    -(rules.daily.baseline.window_days + rules.daily.persistence.lookback_days),
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
        features: defs,
        rules,
        inColdStart: cold,
        explicitDomains: p.explicitDomains,
      });
      if (!child.baselineReadyAt && readyAt) {
        await deps.db.doc(childDocPath(child.familyId, child.childId)).update({
          baselineReadyAt: readyAt,
        });
      }
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

  await store.writePartition('baselines', date, baselines);
  await store.writePartition('risk_levels_daily', date, levels);

  try {
    await store.refreshAnomalies(date, {
      retrain: new Date(`${date}T00:00:00Z`).getUTCDay() === 0,
      threshold: rules.daily.anomaly_prob_threshold,
      modelVersion: `arima_plus@${kb.version}`,
    });
  } catch (err) {
    logger.warn('daily.anomalies_failed', {
      error: err instanceof Error ? err : new Error('unknown'),
    });
  }

  const result = { date, processed: levels.length, failed, changed };
  logger.info('daily.done', result);
  return result;
}
