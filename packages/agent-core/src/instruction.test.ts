import type { Kb } from '@ijime/kb-loader';
import { describe, expect, it } from 'vitest';

import { buildPetInstruction, fillTemplate, PROMPT_PATHS } from './instruction.js';
import type { ChildContext } from './tools.js';

const files: Record<string, string> = {
  [PROMPT_PATHS.charter]: '# 守り手の約束\nあなたは「{petName}」です。\n',
  [PROMPT_PATHS.persona('moko')]: '# キャラクター：もこ\n',
  [PROMPT_PATHS.grade('low')]: '# 学年への合わせ方：小学校低学年\n',
  [PROMPT_PATHS.status]:
    '# いまの状況\n- 日本時間：{localTime}（{dayType}）\n- 最近の様子：{recentTrend}\n- 覚えていること：{memories}\n- 返事を待っている相談：{pendingConsultation}\n- 気にかけてほしいこと：{careFlag}\n',
  [PROMPT_PATHS.voice]: '# 音声での話し方\n',
};

const kb = {
  text: async (p: string) => {
    const f = files[p];
    if (f === undefined) throw new Error(`missing ${p}`);
    return f;
  },
} as unknown as Kb;

const status: ChildContext = {
  gradeBand: 'low',
  characterId: 'moko',
  localTime: '2026-09-29 16:00',
  dayType: 'school_day',
  recentTrend: 'ここ数日、朝の気分が低め',
  careFlag: true,
};

describe('buildPetInstruction', () => {
  it('layers charter → persona → grade → status in order and fills variables', async () => {
    const s = await buildPetInstruction(kb, {
      characterId: 'moko',
      gradeBand: 'low',
      petName: 'もこ',
      status,
      memories: ['ねこが すき'],
      voice: false,
    });
    const idx = (t: string) => s.indexOf(t);
    expect(idx('守り手の約束')).toBeGreaterThanOrEqual(0);
    expect(idx('守り手の約束')).toBeLessThan(idx('キャラクター：もこ'));
    expect(idx('キャラクター：もこ')).toBeLessThan(idx('小学校低学年'));
    expect(idx('小学校低学年')).toBeLessThan(idx('いまの状況'));
    expect(s).toContain('「もこ」です');
    expect(s).toContain('2026-09-29 16:00（学校のある日）');
    expect(s).toContain('ねこが すき');
    expect(s).toContain('いつもより気にかけて');
    expect(s).not.toContain('{');
    expect(s).not.toContain('音声での話し方');
  });

  it('appends the voice rules only in voice mode', async () => {
    const s = await buildPetInstruction(kb, {
      characterId: 'moko',
      gradeBand: 'low',
      petName: 'もこ',
      status: { ...status, recentTrend: '', careFlag: false, pendingConsultationId: 'cs_1' },
      memories: [],
      voice: true,
    });
    expect(s.endsWith('# 音声での話し方')).toBe(true);
    expect(s).toContain('最近の様子：特になし');
    expect(s).toContain('覚えていること：なし');
    expect(s).toContain('返事を待っている相談：あり');
  });

  it('leaves unknown placeholders untouched', () => {
    expect(fillTemplate('{a} {b}', { a: 'x' })).toBe('x {b}');
  });
});
