import type { ContextCategory, Domain } from '@ijime/api-types';
import type { FeatureDefinition } from '@ijime/kb-loader';

import { isScoredSignal, type Scoring } from '../scoring.js';

// signals ドキュメントのうち集計に使うフィールド。metric がないものはモデルが選んだシグナル
export type SignalRow = {
  domain: Domain;
  value: number;
  metric?: { name: string; value: number };
  signalDefId?: string;
  scoring?: string;
};

export type FeatureValue = { name: string; domain: Domain; value: number };

function matches(def: FeatureDefinition, s: SignalRow): number | undefined {
  if ('metric' in def.source) {
    if (s.metric?.name !== def.source.metric) return undefined;
    const v = s.metric.value;
    if (def.filter) {
      const [lo, hi] = def.filter.outside;
      if (v >= lo && v < hi) return undefined;
    }
    return v;
  }
  if (s.metric || s.domain !== def.source.model_domain) return undefined;
  return s.value;
}

// 子ども1人の1日分の signals → 日次特徴。その日にシグナルが1件もなければ、1日分まるごとデータなしとする。
// スコア対象の特徴には observe シグナルを集計しない。observe シグナルだけで構成される特徴は通常どおり集計して保存するが、レベル判定には使わない
export function aggregateDay(
  signals: readonly SignalRow[],
  defs: readonly FeatureDefinition[],
  scoring?: Scoring,
): FeatureValue[] {
  if (signals.length === 0) return [];
  const scoredSignals = scoring ? signals.filter((s) => isScoredSignal(s, scoring)) : signals;
  const out: FeatureValue[] = [];
  for (const def of defs) {
    const pool = scoring?.scored(def) ? scoredSignals : signals;
    const values = pool.map((s) => matches(def, s)).filter((v): v is number => v !== undefined);
    let value: number | undefined;
    switch (def.agg) {
      case 'count':
        value = values.length;
        break;
      case 'sum':
        value = values.reduce((a, b) => a + b, 0);
        break;
      case 'mean':
        value = values.length ? values.reduce((a, b) => a + b, 0) / values.length : undefined;
        break;
      case 'max':
        value = values.length ? Math.max(...values) : undefined;
        break;
    }
    if (value !== undefined) out.push({ name: def.name, domain: def.domain, value });
  }
  return out;
}

export function contextFeatures(categories: readonly ContextCategory[]): FeatureValue[] {
  return categories.map((c) => ({ name: `x_${c}_flag`, domain: 'x', value: 1 }));
}
