import { BaseLlm, type BaseLlmConnection, type LlmRequest, type LlmResponse } from '@google/adk';
import { FinishReason, type Content, type Part } from '@google/genai';

export type ScriptedCall = { name: string; args: Record<string, unknown> };
export type ScriptedStep = { text?: string; calls?: ScriptedCall[] };

export type ScriptContext = {
  lastUserText: string;
  toolResults: { name: string; response: unknown }[];
  turnIndex: number;
};

export type Script = (ctx: ScriptContext) => ScriptedStep;

export const SENTENCE_SPLIT = /(?<=[。！？!?\n])/;

export function lastUserText(contents: Content[]): string {
  for (let i = contents.length - 1; i >= 0; i--) {
    const c = contents[i]!;
    if (c.role !== 'user') continue;
    const text = (c.parts ?? [])
      .map((p) => p.text ?? '')
      .join('')
      .trim();
    if (text) return text;
  }
  return '';
}

function toolResultsSinceLastUserText(contents: Content[]): { name: string; response: unknown }[] {
  const out: { name: string; response: unknown }[] = [];
  for (let i = contents.length - 1; i >= 0; i--) {
    const c = contents[i]!;
    const parts = c.parts ?? [];
    if (c.role === 'user' && parts.some((p) => p.text)) break;
    for (const p of parts) {
      if (p.functionResponse) {
        out.unshift({ name: p.functionResponse.name ?? '', response: p.functionResponse.response });
      }
    }
  }
  return out;
}

export class ScriptedLlm extends BaseLlm {
  static override readonly supportedModels: Array<string | RegExp> = [/^scripted/];
  private turnIndex = 0;
  readonly requests: LlmRequest[] = [];

  constructor(
    private readonly script: Script,
    private readonly opts: { delayMs?: number; model?: string } = {},
  ) {
    super({ model: opts.model ?? 'scripted-pet' });
  }

  override async *generateContentAsync(
    llmRequest: LlmRequest,
    stream = false,
  ): AsyncGenerator<LlmResponse, void> {
    this.requests.push(llmRequest);
    const toolResults = toolResultsSinceLastUserText(llmRequest.contents);
    const step = this.script({
      lastUserText: lastUserText(llmRequest.contents),
      toolResults,
      turnIndex: this.turnIndex++,
    });

    if (step.calls && step.calls.length > 0) {
      const parts: Part[] = step.calls.map((c) => ({
        functionCall: { name: c.name, args: c.args },
      }));
      yield { content: { role: 'model', parts }, turnComplete: true };
      return;
    }

    const text = step.text ?? '';
    if (stream) {
      const pieces = text.split(SENTENCE_SPLIT).filter((p) => p.length > 0);
      for (const piece of pieces) {
        if (this.opts.delayMs) await new Promise((r) => setTimeout(r, this.opts.delayMs));
        yield { content: { role: 'model', parts: [{ text: piece }] }, partial: true };
      }
    }
    yield {
      content: { role: 'model', parts: [{ text }] },
      turnComplete: true,
      finishReason: FinishReason.STOP,
    };
  }

  override connect(): Promise<BaseLlmConnection> {
    return Promise.reject(new Error('ScriptedLlm does not support live connections'));
  }
}

export function petDemoScript(): Script {
  return ({ lastUserText: t, toolResults }) => {
    const already = new Set(toolResults.map((r) => r.name));
    if (t.startsWith('# ペットからの日常の声かけ')) {
      if (!already.has('set_expression'))
        return { calls: [{ name: 'set_expression', args: { expression: 'together' } }] };
      return {
        text: t.includes('時間帯: morning')
          ? 'おはよう！きょうも じぶんの ペースで いこうね。'
          : t.includes('時間帯: after_school')
            ? 'おかえり！ここで ゆっくり していってね。'
            : 'きょうも おつかれさま。ゆっくり やすんでね。',
      };
    }
    const crisis = /死にたい|消えたい|いなくなりたい|しにたい|きえたい/.test(t);
    const bullied = /無視|むし|ハブ|なぐ|たた|いじめ|お金|とられ/.test(t);
    const sad = /つらい|かなしい|悲し|いや|こわい|泣|さみし|寂し/.test(t);
    const happy = /たのし|楽し|うれし|嬉し|やった|すき|好き/.test(t);
    const remember = /おぼえて|覚えて/.test(t);
    const tellAdult =
      /(?:おとな|大人|せんせい|先生)に\s*(?:はなしたい|話したい|つたえたい|伝えたい|そうだんしたい|相談したい)/.test(
        t,
      );

    if (crisis && !already.has('escalate_crisis')) {
      return { calls: [{ name: 'escalate_crisis', args: { category: 'self_harm' } }] };
    }
    if (tellAdult && !already.has('start_tell_adult')) {
      return { calls: [{ name: 'start_tell_adult', args: {} }] };
    }
    if (tellAdult) return { text: 'はなしてくれて ありがとう。つたえかたを いっしょに えらぼう。' };
    if (bullied && !already.has('search_skill')) {
      return {
        calls: [
          { name: 'set_expression', args: { expression: 'worried' } },
          { name: 'search_skill', args: { query: '無視 排除 ハブられた' } },
        ],
      };
    }
    if (bullied) {
      return {
        text: 'それは とても つらかったね。はなしてくれて ありがとう。いまは きいていて ほしい？',
      };
    }
    if (remember && !already.has('remember')) {
      return {
        calls: [
          { name: 'set_expression', args: { expression: 'happy' } },
          { name: 'remember', args: { content: t.slice(0, 60), category: 'other' } },
        ],
      };
    }
    if (already.size === 0) {
      const expression = sad ? 'caring' : happy ? 'celebrate' : 'together';
      const calls: ScriptedCall[] = [{ name: 'set_expression', args: { expression } }];
      if (sad)
        calls.push({
          name: 'offer_quick_replies',
          args: { intents: ['listen_only', 'change_topic', 'pause'] },
        });
      return { calls };
    }
    if (remember) {
      const result = toolResults.find((r) => r.name === 'remember')?.response as
        { proposalId?: string; status?: string } | undefined;
      return {
        text:
          result?.proposalId && result.status === 'pending'
            ? 'このことを おぼえても いい？ ボタンで えらんでね。'
            : 'いまは おぼえる じゅんびが できなかったよ。',
      };
    }
    if (sad) return { text: 'そっか…それは いやだったね。となりに いるよ。' };
    if (happy) return { text: 'わあ、いいね！ それで それで？' };
    return { text: 'へえ、そうなんだ！ もっと きかせて。' };
  };
}
