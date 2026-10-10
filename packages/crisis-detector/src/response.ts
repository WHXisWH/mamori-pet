import {
  CRISIS_HIT_CATEGORIES,
  type CrisisHitCategory,
  type GradeBand,
  type HelpResource,
} from '@ijime/api-types';
import { hotlinesSchema, type Kb } from '@ijime/kb-loader';

import type { CrisisCheck } from './detector.js';

// 危機のときに子どもに見せる定型文と相談窓口（テキストモードと音声モードで共用。モデルを経由しない）
export type SafeModeCopy = Record<GradeBand | 'family_harm', string[]>;

export async function loadSafeModeCopy(kb: Kb): Promise<SafeModeCopy> {
  const read = async (g: string) =>
    (await kb.text(`templates/safe_mode/${g}.ja.txt`)).trim().split('\n');
  return {
    low: await read('low'),
    high: await read('high'),
    jhs: await read('jhs'),
    family_harm: await read('family_harm'),
  };
}

export async function loadHotlines(
  kb: Kb,
): Promise<{ version: string; resources: HelpResource[] }> {
  const hotlines = await kb.yaml('resources/hotlines.yaml', hotlinesSchema);
  const resources: HelpResource[] = hotlines.resources.map((r) => {
    const out: HelpResource = { id: r.id, name: r.name, audience: r.audience };
    if (r.phone !== undefined) out.phone = r.phone;
    if (r.url !== undefined) out.url = r.url;
    if (r.hours !== undefined) out.hours = r.hours;
    return out;
  });
  return { version: `${kb.version}/${hotlines.version}`, resources };
}

// テンプレートのうち、かっこで始まる行は大人向けの説明、「（はい／いいえ）」はボタンの案内なので、どちらも表示しない
export function safeModeMessage(copy: string[]): string {
  return copy
    .filter((l) => !l.startsWith('（'))
    .map((l) => l.replace(/（はい ?\/ ?いいえ）/g, '').trim())
    .join('\n');
}

// どの危機でも緊急通報番号は残す。家庭内での危害のときは児童相談所、それ以外は子ども向けの相談窓口を示す
export function crisisResponse(input: {
  familyHarmSuspected: boolean;
  gradeBand: GradeBand;
  copy: SafeModeCopy;
  hotlines: HelpResource[];
}): { message: string; resources: HelpResource[] } {
  const lines = input.familyHarmSuspected ? input.copy.family_harm : input.copy[input.gradeBand];
  const ids = input.familyHarmSuspected
    ? ['jidou_soudan', 'emergency']
    : ['sos_dial', 'childline', 'emergency'];
  return {
    message: safeModeMessage(lines),
    resources: input.hotlines.filter((h) => ids.includes(h.id)),
  };
}

export type CrisisRouting = { category: CrisisHitCategory; familyHarmSuspected: boolean };

const HIT_CATEGORIES: ReadonlySet<string> = new Set(CRISIS_HIT_CATEGORIES);

// ヒットした検知結果 → イベントのカテゴリ。カテゴリがなければ other（保護者に通知する）
export function routingOfCheck(check: Pick<CrisisCheck, 'category'>): CrisisRouting {
  const category = check.category === 'none' ? 'other' : check.category;
  return { category, familyHarmSuspected: category === 'family_harm' };
}

// 保存済みの crisisEvents を読み戻す。category のない古いレコードは当時の familyHarmSuspected をそのまま使う
export function routingOfRecord(data: {
  category?: unknown;
  familyHarmSuspected?: unknown;
}): CrisisRouting {
  const category: CrisisHitCategory =
    typeof data.category === 'string' && HIT_CATEGORIES.has(data.category)
      ? (data.category as CrisisHitCategory)
      : data.familyHarmSuspected === false
        ? 'other'
        : 'family_harm';
  return { category, familyHarmSuspected: category === 'family_harm' };
}

export type CrisisTrigger = 'text' | 'voice' | 'artwork' | 'island';

export function crisisEventDoc(input: {
  triggerType: CrisisTrigger;
  sourceRef: string;
  check: CrisisCheck;
  now: Date;
  // 再審査でのヒット（モデルが利用できないときに保留した入力が、あとから危機と判定された）：子どもはその時点ではセーフモードを見ていない
  delayed?: boolean;
}): Record<string, unknown> {
  return {
    triggerType: input.triggerType,
    sourceRef: input.sourceRef,
    detection: {
      keywordMatched: input.check.keywordMatched,
      method: input.check.method,
      category: input.check.category,
      confidence: input.check.confidence,
      availability: input.check.availability ?? 'verified',
      ...(input.delayed ? { delayed: true } : {}),
    },
    category: input.check.category,
    familyHarmSuspected: input.check.familyHarmSuspected,
    timeline: [{ step: input.delayed ? 'detected_on_recheck' : 'safe_mode_shown', at: input.now }],
    status: 'open',
    createdAt: input.now,
  };
}
