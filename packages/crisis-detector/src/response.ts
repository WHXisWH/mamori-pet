import type { GradeBand, HelpResource } from '@ijime/api-types';
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

// 家庭内での危害が疑われるときは児童相談所と警察への通報番号だけを示す（保護者には通知しない）。それ以外は子どもが自分でかけられる相談窓口を示す
export function crisisResponse(input: {
  familyHarmSuspected: boolean;
  gradeBand: GradeBand;
  copy: SafeModeCopy;
  hotlines: HelpResource[];
}): { message: string; resources: HelpResource[] } {
  const lines = input.familyHarmSuspected ? input.copy.family_harm : input.copy[input.gradeBand];
  const ids = input.familyHarmSuspected ? ['jidou_soudan', 'emergency'] : ['sos_dial', 'childline'];
  return {
    message: safeModeMessage(lines),
    resources: input.hotlines.filter((h) => ids.includes(h.id)),
  };
}

export type CrisisTrigger = 'text' | 'voice' | 'artwork' | 'island';

export function crisisEventDoc(input: {
  triggerType: CrisisTrigger;
  sourceRef: string;
  check: CrisisCheck;
  now: Date;
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
    },
    familyHarmSuspected: input.check.familyHarmSuspected,
    timeline: [{ step: 'safe_mode_shown', at: input.now }],
    status: 'open',
    createdAt: input.now,
  };
}
