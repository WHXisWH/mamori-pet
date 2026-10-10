import {
  signalDefinitionSchema,
  type FeatureDefinition,
  type Kb,
  type SignalDefinition,
} from '@ijime/kb-loader';

// ナレッジベースで scoring: observe のシグナルは抽出と保存だけを行い、リスクエンジンは読まない（docs/01-prd.md「モジュール1：ナレッジベース（Skill）とリスクレベル分類」の D 領域、2026-10-03 決定）
export async function loadSignalDefs(kb: Kb): Promise<SignalDefinition[]> {
  const paths = kb.paths('signals/').filter((p) => p.endsWith('.yaml'));
  return Promise.all(paths.map((p) => kb.yaml(p, signalDefinitionSchema)));
}

export type Scoring = {
  observeIds: ReadonlySet<string>;
  scored: (f: FeatureDefinition) => boolean;
};

// 現在の kb を正とするが、シグナルドキュメントに書き込み時の scoring があればそれも認める（古いドキュメントにはこのフィールドがない）
export function scoringOf(signalDefs: readonly SignalDefinition[]): Scoring {
  const observeIds = new Set(
    signalDefs.filter((d) => d.scoring === 'observe').map((d) => d.signal_id),
  );
  const feeds = (f: FeatureDefinition, d: SignalDefinition) =>
    'metric' in f.source
      ? d.metric === f.source.metric
      : d.method === 'model' && d.domain === f.source.model_domain;
  // 特徴はスコア対象のシグナル源が1つでもあればスコア対象。kb に由来が見つからない特徴はスコア対象として扱う
  const scored = (f: FeatureDefinition) => {
    const sources = signalDefs.filter((d) => feeds(f, d));
    return sources.length === 0 || sources.some((d) => d.scoring !== 'observe');
  };
  return { observeIds, scored };
}

export function isScoredSignal(
  s: { scoring?: unknown; signalDefId?: unknown },
  scoring: Pick<Scoring, 'observeIds'>,
): boolean {
  if (s.scoring === 'observe') return false;
  return !(typeof s.signalDefId === 'string' && scoring.observeIds.has(s.signalDefId));
}
