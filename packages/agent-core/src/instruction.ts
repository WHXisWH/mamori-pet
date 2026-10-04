import type { CharacterId, GradeBand } from '@ijime/api-types';
import type { Kb } from '@ijime/kb-loader';
import { agent } from '@ijime/config';

import type { ChildContext } from './tools.js';

export const PROMPT_PATHS = {
  charter: 'prompts/charter.md',
  persona: (c: CharacterId) => `prompts/persona/${c}.md`,
  grade: (g: GradeBand) => `prompts/grade/${g}.md`,
  status: 'prompts/status.md',
  voice: 'prompts/voice.md',
} as const;

export type InstructionInput = {
  characterId: CharacterId;
  gradeBand: GradeBand;
  petName: string;
  status: ChildContext;
  memories: readonly string[];
  voice: boolean;
};

export function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, key: string) => vars[key] ?? m);
}

export function statusVars(
  status: ChildContext,
  memories: readonly string[],
): Record<string, string> {
  return {
    localTime: status.localTime,
    dayType: status.dayType === 'school_day' ? '学校のある日' : '休みの日',
    recentTrend: status.recentTrend
      ? JSON.stringify(status.recentTrend.slice(0, agent.contextStatusChars))
      : '特になし',
    memories:
      memories.length > 0
        ? memories
            .slice(0, agent.contextMemories)
            .map((text) => JSON.stringify(text))
            .join('、')
        : 'なし',
    pendingConsultation: status.pendingConsultationId
      ? `あり (${JSON.stringify(status.pendingConsultationId)}${status.followUpAt ? `, ${status.followUpAt}` : ''})`
      : 'なし',
    careFlag: status.careFlag ? 'いつもより気にかけて声をかける' : 'なし',
  };
}

export async function buildPetInstruction(kb: Kb, input: InstructionInput): Promise<string> {
  const [charter, persona, grade, status] = await Promise.all([
    kb.text(PROMPT_PATHS.charter),
    kb.text(PROMPT_PATHS.persona(input.characterId)),
    kb.text(PROMPT_PATHS.grade(input.gradeBand)),
    kb.text(PROMPT_PATHS.status),
  ]);
  const layers = [
    fillTemplate(charter, { petName: input.petName }),
    persona,
    grade,
    fillTemplate(status, statusVars(input.status, input.memories)),
  ];
  if (input.voice) layers.push(await kb.text(PROMPT_PATHS.voice));
  return layers.map((l) => l.trim()).join('\n\n');
}

const DEFAULT_PET_NAMES: Record<CharacterId, string> = {
  moko: 'もこ',
  pokke: 'ぽっけ',
  togemaru: 'トゲまる',
  nami: 'なみ',
  hoshi: 'ほし',
  hidden: 'たまご',
};

export function defaultPetName(c: CharacterId): string {
  return DEFAULT_PET_NAMES[c] ?? 'ペット';
}
