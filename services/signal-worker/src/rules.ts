import type { Domain, GradeBand, SignalScoring, TypingMetrics } from '@ijime/api-types';
import { island as islandConfig } from '@ijime/config';
import type { IslandGeometryRules, SignalDefinition } from '@ijime/kb-loader';

import {
  matchEvidence,
  type Attribution,
  type ContextKind,
  type EvidenceInput,
} from './evidence.js';

// 純粋関数：ルールシグナルとモデル出力の検証。I/O には触れない
export type Metric = { name: string; value: number };

export type SignalDraft = {
  signalDefId: string;
  domain: Domain;
  value: number;
  explicit: boolean;
  // score はリスク計算に使う。observe は保存するだけ
  scoring?: SignalScoring;
  metric?: Metric;
  contextKind?: ContextKind;
  evidenceMatched?: boolean;
};

export type Defs = ReadonlyMap<string, SignalDefinition>;

export function indexDefs(defs: readonly SignalDefinition[]): Map<string, SignalDefinition> {
  return new Map(defs.map((d) => [d.signal_id, d]));
}

// 日本にはサマータイムがないため、+9 時間で固定
export function jst(d: Date): { localDate: string; hour: number } {
  const t = new Date(d.getTime() + 9 * 3_600_000);
  return { localDate: t.toISOString().slice(0, 10), hour: t.getUTCHours() };
}

function rule(defs: Defs, id: string, value: number, metricName?: string): SignalDraft[] {
  const def = defs.get(id);
  if (!def || def.method !== 'rule' || !def.metric) return [];
  return [
    {
      signalDefId: id,
      domain: def.domain,
      value: 1,
      explicit: false,
      scoring: def.scoring,
      metric: { name: metricName ?? def.metric, value },
    },
  ];
}

export function hourSignals(defs: Defs, sentAt: Date): SignalDraft[] {
  return rule(defs, 'I-HOUR-001', jst(sentAt).hour);
}

export function typingSignals(defs: Defs, t: TypingMetrics): SignalDraft[] {
  const ratio = t.keyCount > 0 ? Math.min(1, t.deleteCount / t.keyCount) : 0;
  return [
    ...rule(defs, 'K-DEL-001', Math.round(ratio * 1000) / 1000),
    ...rule(defs, 'K-COMP-001', t.composeMs),
    ...rule(defs, 'K-PAUSE-001', t.longPauseCount),
  ];
}

export type VoiceFeatures = { speechRate: number; pauseRatio: number; pitchMeanHz?: number };

export function voiceSignals(defs: Defs, v: VoiceFeatures): SignalDraft[] {
  return [
    ...rule(defs, 'V-RATE-001', v.speechRate),
    ...rule(defs, 'V-PAUSE-001', v.pauseRatio),
    ...(v.pitchMeanHz !== undefined ? rule(defs, 'V-PITCH-001', v.pitchMeanHz) : []),
  ];
}

export function moodSignals(defs: Defs, score: number): SignalDraft[] {
  return rule(defs, 'M-MOOD-001', score);
}

export function homeSignals(defs: Defs, arrivedAt: Date): SignalDraft[] {
  return rule(defs, 'I-HOME-001', jst(arrivedAt).hour);
}

export type StoryOutcome = 'positive' | 'compensated' | 'negative' | 'unclear';

// 作品特徴の出力。根拠はメモリ上で検証するだけで、artworks.features には書き込まない。
export type ArtworkFeatures = Attribution & {
  selfPresent: boolean;
  selfSizeRatio?: number | null;
  selfPosition?: { x: number; y: number } | null;
  othersCount: number;
  nearestOtherDist?: number | null;
  isolated?: boolean | null;
  storyOutcome?: StoryOutcome | null;
  explicitHarm: boolean;
};

const round3 = (v: number) => Math.round(v * 1000) / 1000;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function storySignals(defs: Defs, outcome: StoryOutcome | null | undefined): SignalDraft[] {
  if (!outcome || outcome === 'unclear') return [];
  return rule(defs, 'D-STORY-001', outcome === 'negative' ? 1 : 0);
}

// explicit の D シグナルには元の計測値がないため、value は 1 で固定
function harmSignals(
  defs: Defs,
  output: Attribution & { explicitHarm: boolean },
  narrative?: string,
): SignalDraft[] {
  const def = defs.get('D-HARM-001');
  const match = matchEvidence(output, narrative === undefined ? undefined : { current: narrative });
  // Image/geometry alone is never a D-HARM source. Keep the other low-weight D features.
  if (!output.explicitHarm || !def || !match.eligible) return [];
  return [
    {
      signalDefId: def.signal_id,
      domain: def.domain,
      value: 1,
      explicit: def.explicit,
      scoring: def.scoring,
      contextKind: match.contextKind,
      evidenceMatched: match.evidenceMatched,
    },
  ];
}

export function artworkSignals(
  defs: Defs,
  type: 'self_portrait' | 'story',
  f: ArtworkFeatures,
  narrative?: string,
): SignalDraft[] {
  const out: SignalDraft[] = [];
  if (f.selfPresent && typeof f.selfSizeRatio === 'number')
    out.push(...rule(defs, 'D-SELF-001', round3(clamp01(f.selfSizeRatio))));
  if (f.selfPresent && typeof f.nearestOtherDist === 'number')
    out.push(...rule(defs, 'D-NEAR-001', round3(Math.max(0, f.nearestOtherDist))));
  if (f.selfPresent && typeof f.isolated === 'boolean')
    out.push(...rule(defs, 'D-ISO-001', f.isolated ? 1 : 0));
  if (type === 'story') out.push(...storySignals(defs, f.storyOutcome));
  out.push(...harmSignals(defs, f, narrative));
  return out;
}

export type IslandPlacement = { id: string; category: string; x: number; y: number };

// 「これがわたし」がないときは、自分に関する項目を null にする（docs/03-database.md islandScenes.features）
export type IslandGeometry = {
  selfToNearestDist: number | null;
  selfToCenterDist: number | null;
  enclosed: boolean | null;
  isolated: boolean | null;
  categoryCounts: Record<string, number>;
};

export type IslandGeometryInput = IslandGeometryRules;

// 純粋な幾何計算：相対座標（0–1）、中心は (0.5, 0.5)。パラメータは kb の rules/island_geometry.yaml から取る。
// 孤立：ほかのキャラクターが isolated_min_other_figures 体以上いて、そのすべてとの距離がしきい値以上のとき。キャラクターが足りなければ孤立としない
export function islandGeometry(
  items: readonly IslandPlacement[],
  selfId: string | undefined,
  rules: IslandGeometryInput,
): IslandGeometry {
  const categoryCounts: Record<string, number> = {};
  for (const i of items) categoryCounts[i.category] = (categoryCounts[i.category] ?? 0) + 1;
  const self = selfId === undefined ? undefined : items.find((i) => i.id === selfId);
  if (!self)
    return {
      selfToNearestDist: null,
      selfToCenterDist: null,
      enclosed: null,
      isolated: null,
      categoryCounts,
    };
  const others = items.filter((i) => i.id !== self.id);
  const dist = (i: IslandPlacement) => Math.hypot(i.x - self.x, i.y - self.y);
  const figures = others.filter((i) => rules.figure_categories.includes(i.category));
  const nearest = figures.length ? Math.min(...figures.map(dist)) : null;
  const minFigures = rules.isolated_min_other_figures ?? 1;

  const near = others.filter((i) => dist(i) > 0 && dist(i) <= rules.neighbor_radius);
  let enclosed = false;
  if (near.length >= rules.enclosed_min_neighbors) {
    const angles = near.map((i) => Math.atan2(i.y - self.y, i.x - self.x)).sort((a, b) => a - b);
    let maxGap = angles[0]! + 2 * Math.PI - angles[angles.length - 1]!;
    for (let k = 1; k < angles.length; k++) maxGap = Math.max(maxGap, angles[k]! - angles[k - 1]!);
    enclosed = maxGap < Math.PI;
  }

  return {
    selfToNearestDist: nearest === null ? null : round3(nearest),
    selfToCenterDist: round3(Math.hypot(self.x - 0.5, self.y - 0.5)),
    enclosed,
    isolated:
      figures.length >= minFigures && figures.every((i) => dist(i) >= rules.isolated_min_dist),
    categoryCounts,
  };
}

export type IslandDiff = { addedCount: number; removedCount: number; movedCount: number };

// 前回のスナップショットとの比較：アイテム ID で追加と削除を判定し、同じ ID の移動量が movedMinDist を超えたら移動とみなす
export function islandDiff(
  previous: readonly IslandPlacement[],
  current: readonly IslandPlacement[],
  movedMinDist: number = islandConfig.movedMinDist,
): IslandDiff {
  const before = new Map(previous.map((i) => [i.id, i]));
  const after = new Map(current.map((i) => [i.id, i]));
  let addedCount = 0;
  let movedCount = 0;
  for (const [id, item] of after) {
    const prev = before.get(id);
    if (!prev) addedCount++;
    else if (Math.hypot(item.x - prev.x, item.y - prev.y) >= movedMinDist) movedCount++;
  }
  let removedCount = 0;
  for (const id of before.keys()) if (!after.has(id)) removedCount++;
  return { addedCount, removedCount, movedCount };
}

export type IslandStory = Attribution & { storyOutcome: StoryOutcome; explicitHarm: boolean };

export function islandSignals(defs: Defs, g: IslandGeometry): SignalDraft[] {
  return [
    ...(g.selfToNearestDist !== null ? rule(defs, 'D-ISLNEAR-001', g.selfToNearestDist) : []),
    ...(g.selfToCenterDist !== null ? rule(defs, 'D-ISLCTR-001', g.selfToCenterDist) : []),
    ...(g.enclosed !== null ? rule(defs, 'D-ENCL-001', g.enclosed ? 1 : 0) : []),
    ...(g.isolated !== null ? rule(defs, 'D-ISO-001', g.isolated ? 1 : 0) : []),
  ];
}

export function islandStorySignals(
  defs: Defs,
  story: IslandStory,
  narrative?: string,
): SignalDraft[] {
  return [...storySignals(defs, story.storyOutcome), ...harmSignals(defs, story, narrative)];
}

export type ModelSignal = Attribution & { signalDefId: string; value: number; explicit: boolean };

export type ExtractOutput = {
  signals: ModelSignal[];
  valence: number;
  topics: string[];
  schoolAvoidance: boolean;
};

export function extractionRuleSignals(defs: Defs, out: ExtractOutput): SignalDraft[] {
  const topicMetric = defs.get('A-TOPIC-001')?.metric;
  return [
    ...rule(defs, 'A-VAL-001', out.valence),
    ...(out.schoolAvoidance ? rule(defs, 'A-SCHL-001', 1) : []),
    ...(topicMetric
      ? [...new Set(out.topics)].flatMap((t) => rule(defs, 'A-TOPIC-001', 1, `${topicMetric}_${t}`))
      : []),
  ];
}

// モデルが選べるのは定義にある A 領域のシグナルだけ。explicit は定義の制約に従う。同じシグナルは最も強い1件だけを残す
export function modelSignalDefs(defs: Defs, domain: Domain, band: GradeBand): SignalDefinition[] {
  return [...defs.values()].filter(
    (d) => d.method === 'model' && d.domain === domain && d.grade_bands.includes(band),
  );
}

export function validateModelSignals(
  allowed: readonly SignalDefinition[],
  raw: readonly ModelSignal[],
  input?: EvidenceInput,
): SignalDraft[] {
  const byId = new Map(allowed.map((d) => [d.signal_id, d]));
  const best = new Map<string, SignalDraft>();
  for (const r of raw) {
    const def = byId.get(r.signalDefId);
    if (!def || !Number.isFinite(r.value)) continue;
    const value = Math.min(1, Math.max(0, r.value));
    if (value === 0) continue;
    const match = matchEvidence(r, input);
    const draft: SignalDraft = {
      signalDefId: def.signal_id,
      domain: def.domain,
      value,
      explicit: r.explicit === true && def.explicit && match.eligible,
      scoring: def.scoring,
      contextKind: match.contextKind,
      evidenceMatched: match.evidenceMatched,
    };
    const prev = best.get(def.signal_id);
    if (
      !prev ||
      (draft.explicit && !prev.explicit) ||
      (draft.explicit === prev.explicit && draft.value > prev.value)
    )
      best.set(def.signal_id, {
        ...draft,
      });
  }
  return [...best.values()];
}
