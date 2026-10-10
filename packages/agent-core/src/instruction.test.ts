import { readFile } from 'node:fs/promises';

import type { Kb } from '@ijime/kb-loader';
import { agent } from '@ijime/config';
import { describe, expect, it } from 'vitest';

import { buildPetInstruction, fillTemplate, PROMPT_PATHS, statusVars } from './instruction.js';
import { petToolDescriptions, petToolSchemas, type ChildContext } from './tools.js';

const files: Record<string, string> = {
  [PROMPT_PATHS.charter]: '# 守り手の約束\nあなたは「{petName}」です。{replyMaxChars}文字以内。\n',
  [PROMPT_PATHS.persona('moko')]: '# キャラクター：もこ\n',
  [PROMPT_PATHS.grade('low')]: '# 学年への合わせ方：小学校低学年\n',
  [PROMPT_PATHS.status]:
    '# いまの状況\n- 日本時間：{localTime}（{dayType}）\n- 最近の様子：{recentTrend}\n- 覚えていること：{memories}\n- 返事を待っている相談：{pendingConsultation}\n- 今回の助けを求める試み：{helpAttempt}\n- 気にかけてほしいこと：{careFlag}\n',
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

  it.each(['low', 'high', 'jhs'] as const)(
    'matches the actual %s output budget',
    async (gradeBand) => {
      const s = await buildPetInstruction(
        { text: async (path: string) => files[path] ?? '# 学年への合わせ方' } as unknown as Kb,
        { characterId: 'moko', gradeBand, petName: 'もこ', status, memories: [], voice: false },
      );
      expect(s).toContain(`${agent.replyMaxChars[gradeBand]}文字以内`);
      expect(s).not.toContain('{replyMaxChars}');
    },
  );

  it('has no help-attempt facts before the child has a consultation', () => {
    expect(statusVars(status, []).helpAttempt).toBe('なし');
  });

  it.each(['unknown', 'talked', 'later', 'needs_help', 'supported', 'paused'] as const)(
    'includes only the small structured attempt state: %s',
    async (state) => {
      const helpAttempt = { choice: 'proxy' as const, state, followUp: 'scheduled' as const };
      const s = await buildPetInstruction(kb, {
        characterId: 'moko',
        gradeBand: 'low',
        petName: 'もこ',
        status: { ...status, helpAttempt },
        memories: [],
        voice: false,
      });
      expect(s).toContain(JSON.stringify(helpAttempt));
      expect(s).not.toContain('{helpAttempt}');
    },
  );

  it('does not serialize extra attempt fields into the model instruction', () => {
    const helpAttempt = {
      state: 'unknown' as const,
      followUp: 'unscheduled' as const,
      transcript: 'PRIVATE_RAW_TRANSCRIPT',
      guardianFeedback: 'PRIVATE_PARENT_FEEDBACK',
    };
    expect(statusVars({ ...status, helpAttempt }, []).helpAttempt).toBe(
      '{"state":"unknown","followUp":"unscheduled"}',
    );
  });
});

describe('prompt source continuity contract', () => {
  const prompt = (name: string) =>
    readFile(new URL(`../../../kb/v0.1.0/prompts/${name}.md`, import.meta.url), 'utf8');

  it('defines quick replies as verbatim child utterances, not the pet response', async () => {
    const source = await prompt('charter');
    expect(source).toContain('子どもがペットに言う言葉');
    expect(source).toContain('そのまま子どもの発言として送信');
    expect(source).toContain('intents を選び、文案を作らない');
    expect(source).toContain('trigger に最新の本人の希望か迷いの根拠も添える');
    expect(source).toContain('根拠がなくツールに拒否されたら、同じ提案を繰り返さず');
    expect(source).toContain('ツールが返す options');
    expect(source).toContain('新しい出来事や気持ちを勝手に足さない');
    expect(petToolDescriptions.offer_quick_replies).toContain('子どもの発言');
    expect(petToolSchemas.offer_quick_replies.shape.intents.description).toContain('子どもの発言');
    expect(petToolSchemas.offer_quick_replies.shape.intents.description).toContain(
      '本人がまだ言っていない体調・感情・被害',
    );
  });

  it('omits repeat permission checks and stops offering buttons after a goodbye', async () => {
    const source = await prompt('charter');
    expect(source).toContain('質問は必要な時だけ1つまで');
    expect(source).toContain('本文で同じ確認を繰り返さない');
    expect(source).toContain('新たな質問・勧誘・ボタンを出さずに待つ');
    expect(source).toContain('許可を取り直す質問は付けない');
    expect(await prompt('grade/low')).toContain('終了時を除き');
  });

  it('keeps the requested adult, the child and the assisting pet distinct', async () => {
    const source = await prompt('charter');
    expect(source).toContain('子どもが今伝えたい大人');
    expect(source).toContain('「{petName}に伝える」と置き換えない');
    expect(source).toContain('先生への自動送信');
    expect(source).toContain('言い出し方の例だと分かるように');
  });

  it('uses natural short Japanese without splitting phrases to meet a length target', async () => {
    const source = await prompt('grade/low');
    expect(source).toContain('助詞や語尾を切り離さない');
    expect(source).toContain('子どもがペットに言う言葉');
    expect(source).toContain('いまは おしまい');
  });

  it('does not interpret an older child wanting to be heard as a request for buttons', async () => {
    const source = await prompt('grade/jhs');
    expect(source).toContain('希望だけでは offer_quick_replies を呼ばない');
    expect(source).toContain('候補が必要だと推測しない');
    expect(petToolDescriptions.offer_quick_replies).toContain('高学年・中学生へ出さない');
  });

  it('treats a generated practice button as a child request, not a completed help action', async () => {
    const source = await prompt('charter');
    expect(source).toContain('このターンでも start_tell_adult を呼んで');
    expect(source).toContain('ボタン選択は転送への同意ではない');
    expect(petToolDescriptions.start_tell_adult).toContain('候補を子どもが選んだ場合も');
  });

  it('distinguishes a stored consultation from an action displayed in this turn', async () => {
    const source = await prompt('status');
    expect(source).toContain('今のチャットに入口を表示したという意味ではない');
    expect(source).toContain('保存済みでも start_tell_adult をこのターンで呼ぶ');
    expect(source).toContain('今は聞いてほしいだけなら、記録があっても呼ばない');
  });

  it('defines unknown, attempted, helped and paused as different child-owned facts', async () => {
    const source = await prompt('status');
    expect(source).toContain('{helpAttempt}');
    expect(source).toContain('子ども自身');
    for (const value of ['unknown', 'talked', 'later', 'needs_help', 'supported', 'paused'])
      expect(source).toContain(value);
    expect(source).toContain('助けになったかは未確認');
    expect(source).toContain('時刻前に催促しない');
    expect(source).toContain('保護者が何をしたか');
  });

  it('supports an invited next step, not interrogation or a permanent help mute', async () => {
    const source = await prompt('charter');
    expect(source).toContain('子どもが自分から話さない限り');
    expect(source).toContain('小さな一歩');
    expect(source).toContain('何を言われたか');
    expect(source).toContain('推測しない');
    expect(source).toContain('supported / paused / stopped');
    expect(source).toContain('別の新しい問題への永久の停止ではない');
    expect(source).toContain('現実の危険には通常の安全ルール');
    expect(source).toContain('大人が対応したはずだと打ち消さない');
    expect(source).toContain('決まった台本にはしない');
    expect(source).toContain('具体的な小さな一歩を前半に');
    expect(source).toContain('考えてもよいかをもう一度聞くだけで終わらない');
    expect(source).toContain('今の自発的な希望を優先');
  });

  it('describes the existing help choices without inventing interface capabilities', async () => {
    const source = await prompt('charter');
    expect(source).toContain('実際に選べるのは self / proxy / not_now');
    expect(source).toContain('画面にない選択肢や機能を表示したとは言わない');
    expect(source).toContain('連絡帳やメモは現実で試す方法として提案してよい');
    expect(source).toContain('先生への自動送信');
  });

  it('requires a fresh help action when the child asks again after a paused followup', async () => {
    const source = await prompt('status');
    expect(source).toContain('paused / stopped は過去の試みの状態');
    expect(source).toContain('start_tell_adult を返答の前に呼ぶ');
    expect(petToolDescriptions.start_tell_adult).toContain('返答文を出す前に必ず呼ぶ');
    expect(petToolDescriptions.start_tell_adult).toContain('助言の文章だけでは入口は表示されない');
    expect(petToolDescriptions.start_tell_adult).toContain('paused / stopped');
  });

  it('keeps proactive greetings ordinary and postpones games during distress or negotiation', async () => {
    const source = await prompt('proactive');
    expect(source).toContain('挨拶を使って結果を聞いたり');
    expect(source).toContain('supported / paused / stopped');
    expect(source).toContain('相談の返事待ち');
    expect(source).toContain('suggest_game を使いません');
    expect(petToolDescriptions.suggest_game).toContain('つらさを話している途中に遊びでそらさない');
    expect(petToolDescriptions.get_child_context).toContain(
      '転送の選択や「話した」は解決を意味しない',
    );
  });
});
