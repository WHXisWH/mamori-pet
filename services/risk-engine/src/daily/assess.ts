import { DOMAINS, type Domain, type RiskLevel } from '@ijime/api-types';
import type { FeatureDefinition, RiskRules } from '@ijime/kb-loader';

import type { Explanation } from '../levels.js';
import { addDays, contextsOn, dayType, type ContextSpan, type DayType } from './calendar.js';

// date → 特徴名 → 値。欠けている特徴は含めない
export type History = ReadonlyMap<string, ReadonlyMap<string, number>>;

export type AssessInput = {
  date: string;
  history: History;
  contexts: readonly ContextSpan[];
  holidays: ReadonlySet<string>;
  features: readonly FeatureDefinition[];
  rules: RiskRules;
  inColdStart: boolean;
  // 当日の explicit シグナルが属し、かつ levels.l3.or_explicit_in に含まれる領域
  explicitDomains: readonly Domain[];
};

export type Baseline = {
  feature: string;
  dayType: DayType;
  median: number;
  iqr: number;
  points: number;
};

export type AssessOutput = {
  level: Exclude<RiskLevel, 'l4'>;
  domainsFlagged: Domain[];
  persistenceDays: Partial<Record<Domain, number>>;
  explanation: Explanation;
  baselines: Baseline[];
};

type DomainStatus = 'deviated' | 'normal' | 'missing';

function quantile(sorted: readonly number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

const byDomainOrder = (a: Domain, b: Domain) => DOMAINS.indexOf(a) - DOMAINS.indexOf(b);

// 純粋関数：特徴の履歴、コンテキスト情報、ルールが同じなら、必ず同じレベルと根拠を返す
export function assess(input: AssessInput): AssessOutput {
  const { date, history, contexts, holidays, features, rules } = input;
  const daily = rules.daily;
  const low = new Set(rules.low_weight_domains);
  const judged = features.filter((f) => f.domain !== 'x');
  const typeCache = new Map<string, DayType>();
  const typeOf = (d: string): DayType => {
    let t = typeCache.get(d);
    if (!t) typeCache.set(d, (t = dayType(d, holidays, contexts, daily.rest_day_contexts)));
    return t;
  };

  const defOf = new Map(judged.map((f) => [f.name, f]));
  const earliest = [...history.keys()].sort()[0] ?? date;

  // 逸脱した日は以降のベースラインに入れない。入れると、続く逸脱がベースラインに吸収され、数日後には逸脱と判定されなくなる
  const deviatedCache = new Map<string, boolean>();
  const deviated = (feature: string, day: string): boolean => {
    const key = `${feature}|${day}`;
    const cached = deviatedCache.get(key);
    if (cached !== undefined) return cached;
    const f = defOf.get(feature)!;
    const v = history.get(day)?.get(feature);
    const b = v === undefined || day <= earliest ? undefined : baseline(feature, day);
    let out = false;
    if (v !== undefined && b) {
      const spread = Math.max(b.iqr, f.min_spread) * daily.deviation.iqr_k;
      out = f.worse === 'up' ? v > b.median + spread : v < b.median - spread;
    }
    deviatedCache.set(key, out);
    return out;
  };

  const baselineCache = new Map<string, Baseline | undefined>();
  const baseline = (feature: string, day: string): Baseline | undefined => {
    const type = typeOf(day);
    const key = `${feature}|${day}`;
    if (baselineCache.has(key)) return baselineCache.get(key);
    const values: number[] = [];
    for (let i = 1; i <= daily.baseline.window_days; i++) {
      const d = addDays(day, -i);
      if (d < earliest) break;
      const v = history.get(d)?.get(feature);
      if (v !== undefined && typeOf(d) === type && !deviated(feature, d)) values.push(v);
    }
    let out: Baseline | undefined;
    if (values.length >= daily.baseline.min_points) {
      values.sort((a, b) => a - b);
      out = {
        feature,
        dayType: type,
        median: quantile(values, 0.5),
        iqr: quantile(values, 0.75) - quantile(values, 0.25),
        points: values.length,
      };
    }
    baselineCache.set(key, out);
    return out;
  };

  const statusCache = new Map<string, Map<Domain, DomainStatus>>();
  const statusOn = (day: string): Map<Domain, DomainStatus> => {
    const cached = statusCache.get(day);
    if (cached) return cached;
    const out = new Map<Domain, DomainStatus>();
    const values = history.get(day);
    for (const f of judged) {
      if (values?.get(f.name) === undefined || !baseline(f.name, day)) continue;
      if (deviated(f.name, day)) out.set(f.domain, 'deviated');
      else if (!out.has(f.domain)) out.set(f.domain, 'normal');
    }
    statusCache.set(day, out);
    return out;
  };

  const weight = (day: string, domain: Domain): number => {
    let w = 1;
    for (const c of contextsOn(day, contexts))
      w = Math.min(w, daily.context_weights[c]?.[domain] ?? 1);
    return w;
  };

  const domains = [...new Set(judged.map((f) => f.domain))].sort(byDomainOrder);
  const persistenceDays: Partial<Record<Domain, number>> = {};
  for (const domain of domains) {
    let days = 0;
    let missing = 0;
    for (let i = 0; i < daily.persistence.lookback_days; i++) {
      const day = addDays(date, -i);
      const s = statusOn(day).get(domain) ?? 'missing';
      if (s === 'normal') break;
      if (s === 'missing') {
        if (++missing >= daily.persistence.break_after_missing_days) break;
        continue;
      }
      missing = 0;
      days += weight(day, domain);
    }
    if (days > 0) persistenceDays[domain] = days;
  }

  // 重みの低い領域は、重みの低くない領域と同時に出たときだけ数える
  const withLowRule = (ds: readonly Domain[]) => (ds.every((d) => low.has(d)) ? [] : [...ds]);

  const result = (
    level: AssessOutput['level'],
    flagged: readonly Domain[],
    extra: Partial<Explanation> = {},
  ): AssessOutput => {
    const sorted = [...flagged].sort(byDomainOrder);
    const days = Math.floor(Math.max(0, ...sorted.map((d) => persistenceDays[d] ?? 0)));
    return {
      level,
      domainsFlagged: sorted,
      persistenceDays,
      explanation: { domains: sorted, days, ...extra },
      baselines: judged.flatMap((f) => {
        const b = baseline(f.name, date);
        return b ? [b] : [];
      }),
    };
  };

  const l3 = rules.levels.l3;
  if (input.explicitDomains.length > 0) {
    return result('l3', input.explicitDomains, { days: 1, explicit: true });
  }
  const today = statusOn(date);
  const todayDeviated = withLowRule(domains.filter((d) => today.get(d) === 'deviated'));
  const todayWeight = todayDeviated.reduce((sum, d) => sum + weight(date, d), 0);
  if (l3.min_domains !== undefined && todayWeight >= l3.min_domains) {
    return result('l3', todayDeviated);
  }

  if (input.inColdStart) return result('l0', []);

  const persistentFor = (minDays: number | undefined) =>
    withLowRule(domains.filter((d) => (persistenceDays[d] ?? 0) >= (minDays ?? 1)));
  const { l1, l2 } = rules.levels;
  const l2Domains = persistentFor(l2.min_days);
  if (l2Domains.length >= (l2.min_domains ?? Infinity)) return result('l2', l2Domains);

  const sa = daily.school_avoidance;
  let avoidDays = 0;
  for (let i = 0; i < sa.window_days; i++) {
    if ((history.get(addDays(date, -i))?.get(sa.feature) ?? 0) > 0) avoidDays++;
  }
  if (avoidDays >= sa.min_days) {
    const saDomain = features.find((f) => f.name === sa.feature)?.domain ?? 'a';
    return { ...result('l2', [saDomain]), explanation: { domains: [saDomain], days: avoidDays } };
  }

  const l1Domains = persistentFor(l1.min_days);
  if (l1Domains.length >= (l1.min_domains ?? Infinity)) return result('l1', l1Domains);
  return result('l0', []);
}
