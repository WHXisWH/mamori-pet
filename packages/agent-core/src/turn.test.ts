import { InMemorySessionService } from '@google/adk';
import type { PetAction, TurnChunk } from '@ijime/api-types';
import { describe, expect, it, vi } from 'vitest';

import { createPetAgent } from './agent.js';
import { PET_APP_NAME } from './firestore-session.js';
import { OutputFilter } from './output-filter.js';
import { petDemoScript, ScriptedLlm, type Script } from './scripted-llm.js';
import { createPetTools, type PetToolExecutor } from './tools.js';
import { runPetTurn } from './turn.js';

const filter = new OutputFilter({
  rules: [
    { id: 'claims_human', label_ja: 'x', patterns: ['人間だよ'] },
    { id: 'absolute_secrecy', label_ja: 'x', patterns: ['絶対(に)?秘密'] },
  ],
});

function executor(): PetToolExecutor & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    getChildContext: vi.fn(async () => ({
      gradeBand: 'high' as const,
      characterId: 'moko' as const,
      localTime: 'x',
      dayType: 'school_day' as const,
      recentTrend: '',
      careFlag: false,
    })),
    searchSkill: vi.fn(async (_c, q) => (calls.push(`search:${q}`), ['まず気持ちを受け止める'])),
    recordMood: vi.fn(async () => {}),
    remember: vi.fn(
      async (_c, content) => (calls.push(`remember:${content}`), { memoryId: 'm_1' }),
    ),
    recall: vi.fn(async () => []),
    suggestGame: vi.fn(async () => true),
    startTellAdult: vi.fn(async () => (calls.push('tell'), { consultationId: 'cs_1' })),
    escalateCrisis: vi.fn(
      async (_c, reason) => (calls.push(`crisis:${reason}`), { crisisId: 'cr_1' }),
    ),
  };
}

async function turn(
  script: Script,
  text: string,
  opts: Partial<Parameters<typeof runPetTurn>[0]> = {},
) {
  const ex = executor();
  const actions: PetAction[] = [];
  const tools = createPetTools(
    ex,
    { childId: 'c_1', sessionId: 's_1', gradeBand: 'high', characterId: 'moko' },
    (a) => actions.push(a),
  );
  const llm = new ScriptedLlm(script);
  const agent = createPetAgent({ model: llm, instruction: 'test', tools });
  const sessionService = new InMemorySessionService();
  await sessionService.createSession({ appName: PET_APP_NAME, userId: 'c_1', sessionId: 's_1' });
  const chunks: TurnChunk[] = [];
  const logs: string[] = [];
  const gen = runPetTurn({
    agent,
    sessionService,
    childId: 'c_1',
    sessionId: 's_1',
    text,
    gradeBand: 'high',
    filter,
    safeReply: 'SAFE',
    actions,
    onLog: (e) => logs.push(e),
    ...opts,
  });
  let result = await gen.next();
  while (!result.done) {
    chunks.push(result.value);
    result = await gen.next();
  }
  const session = await sessionService.getSession({
    appName: PET_APP_NAME,
    userId: 'c_1',
    sessionId: 's_1',
  });
  return { chunks, outcome: result.value, ex, actions, logs, llm, session: session! };
}

const deltas = (chunks: TurnChunk[]) =>
  chunks.filter((c) => c.type === 'delta').map((c) => (c as { text: string }).text);
const actionTypes = (chunks: TurnChunk[]) =>
  chunks.filter((c) => c.type === 'action').map((c) => (c as { action: PetAction }).action.type);

describe('runPetTurn', () => {
  it.each([
    [9000, null],
    [16000, 'SAFE'],
  ] as const)(
    'bounds the default first response wait at a %i ms model delay',
    async (delayMs, fallback) => {
      vi.useFakeTimers();
      try {
        const agent = createPetAgent({
          model: new ScriptedLlm(() => ({ text: 'そっか。' }), { delayMs }),
          instruction: 'test',
          tools: [],
        });
        const running = turn(() => ({ text: '' }), 'やあ', { agent });
        await vi.advanceTimersByTimeAsync(delayMs + 1);
        const { outcome } = await running;
        expect(outcome.fallback).toBe(fallback);
        expect(outcome.replyText).toBe(fallback ?? 'そっか。');
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('allows real tool progress before the first visible sentence', async () => {
    vi.useFakeTimers();
    try {
      const model = new ScriptedLlm(({ toolResults }) =>
        toolResults.length
          ? { text: 'そっか。' }
          : { calls: [{ name: 'set_expression', args: { expression: 'together' } }] },
      );
      const generate = model.generateContentAsync.bind(model);
      model.generateContentAsync = async function* (request, stream) {
        await new Promise((resolve) => setTimeout(resolve, 80));
        yield* generate(request, stream);
      };
      const agent = createPetAgent({
        model,
        instruction: 'test',
        tools: createPetTools(
          executor(),
          { childId: 'c_1', sessionId: 's_1', gradeBand: 'high', characterId: 'moko' },
          () => {},
        ),
      });
      const fields: Record<string, unknown>[] = [];
      const running = turn(() => ({ text: '' }), 'やあ', {
        agent,
        firstTokenTimeoutMs: 120,
        turnTimeoutMs: 1000,
        onLog: (_event, value) => fields.push(value),
      });
      await vi.advanceTimersByTimeAsync(80);
      await vi.advanceTimersByTimeAsync(80);
      const { outcome } = await running;
      expect(outcome.fallback).toBeNull();
      expect(outcome.replyText).toBe('そっか。');
      expect(fields.at(-1)?.['firstModelEventMs']).toBe(80);
      expect(fields.at(-1)?.['firstVisibleTextMs']).toBe(160);
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles an uncooperative model before returning a timeout fallback', async () => {
    vi.useFakeTimers();
    try {
      const agent = createPetAgent({
        model: new ScriptedLlm(() => ({ text: 'late' }), { delayMs: 500 }),
        instruction: 'x',
        tools: [],
      });
      let completed = false;
      const running = turn(() => ({ text: '' }), 'やあ', { agent, firstTokenTimeoutMs: 50 }).then(
        (value) => {
          completed = true;
          return value;
        },
      );
      await vi.advanceTimersByTimeAsync(60);
      expect(completed).toBe(false);
      await vi.advanceTimersByTimeAsync(500);
      expect(completed).toBe(true);
      expect((await running).outcome.fallback).toBe('SAFE');
    } finally {
      vi.useRealTimers();
    }
  });

  it('drains in-flight tools and stops queued tools before returning done', async () => {
    vi.useFakeTimers();
    try {
      const effects: string[] = [];
      const ex = executor();
      ex.recordMood = vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        effects.push('committed');
      });
      const agent = createPetAgent({
        model: new ScriptedLlm(() => ({
          calls: [
            { name: 'record_mood', args: { weather: 'sunny' } },
            { name: 'remember', args: { content: 'late', category: 'like' } },
          ],
        })),
        instruction: 'x',
        tools: createPetTools(
          ex,
          { childId: 'c_1', sessionId: 's_1', gradeBand: 'high', characterId: 'moko' },
          () => {},
        ),
      });
      const running = turn(() => ({ text: '' }), 'やあ', {
        agent,
        firstTokenTimeoutMs: 50,
        turnTimeoutMs: 80,
      }).then((value) => {
        effects.push('done');
        return value;
      });
      await vi.advanceTimersByTimeAsync(90);
      expect(effects).toEqual([]);
      await vi.advanceTimersByTimeAsync(100);
      const value = await running;
      expect(value.outcome.fallback).toBe('SAFE');
      expect(effects).toEqual(['committed', 'done']);
      expect(ex.remember).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1000);
      expect(effects).toEqual(['committed', 'done']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('streams sentences, forwards front-end actions and ends with done', async () => {
    const { chunks, outcome, session } = await turn(petDemoScript(), 'きょうは たのしかった！');
    expect(actionTypes(chunks)).toEqual(['set_expression']);
    expect(deltas(chunks).join('')).toBe('わあ、いいね！ それで それで？');
    expect(deltas(chunks).length).toBeGreaterThan(1);
    expect(chunks.at(-1)?.type).toBe('done');
    expect(outcome.fallback).toBeNull();
    expect(outcome.toolCalls).toEqual(['set_expression']);
    expect(session.events.map((e) => e.content?.role)).toContain('user');
  });

  it('never reuses a signed tool-call ID for a partial reply after model failure', async () => {
    const model = new ScriptedLlm(() => ({ text: '' }));
    let requests = 0;
    model.generateContentAsync = async function* () {
      if (requests++ > 0) throw new Error('model_failed_after_tool');
      yield {
        content: {
          role: 'model',
          parts: [
            { text: 'そっか。' },
            {
              thoughtSignature: 'opaque-signature',
              functionCall: { id: 'call_mood', name: 'record_mood', args: { weather: 'sunny' } },
            },
          ],
        },
      };
    };
    const agent = createPetAgent({
      model,
      instruction: 'test',
      tools: createPetTools(
        executor(),
        { childId: 'c_1', sessionId: 's_1', gradeBand: 'high', characterId: 'moko' },
        () => {},
      ),
    });
    const { session, outcome } = await turn(() => ({ text: '' }), 'やあ', { agent });
    const call = session.events.find((event) =>
      event.content?.parts?.some((part) => part.functionCall?.id === 'call_mood'),
    );
    expect(call).toBeDefined();
    expect(outcome.replyMessageId).not.toBe(call!.id);
    expect(new Set(session.events.map((event) => event.id)).size).toBe(session.events.length);
    expect(call!.content!.parts![1]!.thoughtSignature).toBe('opaque-signature');
  });

  it.each(['fallback', 'during_persistence'] as const)(
    'does not emit done after upstream cancellation at %s',
    async (stage) => {
      const controller = new AbortController();
      const sessionService = new InMemorySessionService();
      await sessionService.createSession({
        appName: PET_APP_NAME,
        userId: 'c_1',
        sessionId: 's_1',
      });
      const append = sessionService.appendEvent.bind(sessionService);
      const writes: string[] = [];
      sessionService.appendEvent = async (request) => {
        if (request.event.content?.role === 'model') {
          writes.push(request.event.id);
          if (stage === 'during_persistence') controller.abort();
        }
        return append(request);
      };
      const gen = runPetTurn({
        agent: createPetAgent({
          model: new ScriptedLlm(() => ({ text: '' })),
          instruction: 'x',
          tools: [],
        }),
        sessionService,
        childId: 'c_1',
        sessionId: 's_1',
        text: 'やあ',
        gradeBand: 'high',
        filter,
        safeReply: 'SAFE',
        actions: [],
        signal: controller.signal,
      });
      expect((await gen.next()).value).toEqual({ type: 'delta', text: 'SAFE' });
      if (stage === 'fallback') controller.abort();
      const end = await gen.next();
      expect(end.done).toBe(true);
      expect(writes).toHaveLength(stage === 'fallback' ? 0 : 1);
    },
  );

  it('scripted exclusion offers support without assuming consent to tell an adult', async () => {
    const { chunks, ex, outcome } = await turn(petDemoScript(), 'きょう みんなに 無視された');
    expect(ex.calls).toEqual(['search:無視 排除 ハブられた']);
    expect(actionTypes(chunks)).toEqual(['set_expression']);
    expect(outcome.toolCalls).toEqual(['set_expression', 'search_skill']);
    expect(deltas(chunks).join('')).toContain('つらかったね');
  });

  it('scripted explicit help request opens the consultation, not a notification', async () => {
    const { chunks, ex } = await turn(petDemoScript(), 'おとなに はなしたい');
    expect(ex.calls).toEqual(['tell']);
    expect(actionTypes(chunks)).toContain('offer_tell_adult');
  });

  it('escalate_crisis is called as a backstop when the model sees crisis language', async () => {
    const script: Script = ({ toolResults }) =>
      toolResults.length === 0
        ? { calls: [{ name: 'escalate_crisis', args: { category: 'self_harm' } }] }
        : { text: '話してくれてありがとう。' };
    const { ex } = await turn(script, 'もう消えたい');
    expect(ex.calls).toEqual(['crisis:self_harm']);
  });

  it('blocks a forbidden sentence, drops the rest and sends the safe reply', async () => {
    const script: Script = () => ({ text: 'ぼくは人間だよ。だから安心して。' });
    const { chunks, outcome, logs, session } = await turn(script, 'きみは にんげん？');
    expect(deltas(chunks)).toEqual(['SAFE']);
    expect(outcome.fallback).toBe('SAFE');
    expect(outcome.replyMessageId).toMatch(/^fallback_/);
    const stored = session.events
      .filter((event) => event.content?.role === 'model')
      .flatMap((event) => event.content?.parts ?? []);
    expect(stored.map((part) => part.text).join('')).toBe('SAFE');
    expect(logs).toContain('filter.output');
  });

  it('marks an empty model response as fallback even when ADK assigned an event ID', async () => {
    const { outcome } = await turn(() => ({ text: '' }), 'やあ');
    expect(outcome.fallback).toBe('SAFE');
    expect(outcome.replyMessageId).toMatch(/^fallback_/);
  });

  it('keeps already-sent sentences and drops only the blocked tail', async () => {
    const script: Script = () => ({ text: 'そっか。絶対に秘密にするね。' });
    const { chunks, outcome } = await turn(script, 'ひみつにして');
    expect(deltas(chunks)).toEqual(['そっか。']);
    expect(outcome.fallback).toBeNull();
    expect(outcome.replyText).toBe('そっか。');
  });

  it('truncates at the grade band length limit', async () => {
    const long = 'とても長い文です。'.repeat(30);
    const { outcome, session } = await turn(() => ({ text: long }), 'ながく はなして');
    expect(outcome.replyText.length).toBeLessThanOrEqual(100);
    expect(outcome.replyText.endsWith('。')).toBe(true);
    expect(
      session.events.find((event) => event.id === outcome.replyMessageId)?.content?.parts,
    ).toEqual([{ text: outcome.replyText }]);
  });

  it.each([
    'おかあさんに はなす れんしゅう、\nいっしょに やろうね。\n\n「ねえ、ちょっと はなしたい\nことが あるの。きいてくれる？」\nから はじめてみよう。',
    'いっしょに れんしゅうしよう。\n「せんせい。\nすこし はなしたいことが あるんです。きょうの ほうかごに きいてもらえますか？」',
  ])('does not stream a partial practice quote when the reply exceeds its budget', async (text) => {
    const { outcome, chunks, session } = await turn(() => ({ text }), 'れんしゅうしたい', {
      gradeBand: 'low',
    });
    expect(outcome.fallback).toBeNull();
    expect(outcome.replyText).toBe(text.slice(0, text.indexOf('。') + 1));
    expect(deltas(chunks).join('')).toBe(outcome.replyText);
    expect(
      session.events.find((event) => event.id === outcome.replyMessageId)?.content?.parts,
    ).toEqual([{ text: outcome.replyText }]);
  });

  it('keeps a complete short quoted example, including punctuation inside the quote', async () => {
    const text = '「せんせい。\nおはなし きいて。」と いってみよう。';
    const { chunks, outcome } = await turn(() => ({ text }), 'れんしゅうしたい', {
      gradeBand: 'low',
    });
    expect(deltas(chunks)).toEqual([text]);
    expect(outcome.replyText).toBe(text);
  });

  it('does not expose an over-budget first sentence as a chopped fragment', async () => {
    const { outcome } = await turn(() => ({ text: 'あ'.repeat(80) + '。' }), 'やあ', {
      gradeBand: 'low',
    });
    expect(outcome.replyText).toBe('SAFE');
    expect(outcome.fallback).toBe('SAFE');
  });

  it('falls back to the safe reply when the model errors', async () => {
    const script: Script = () => {
      throw new Error('model down');
    };
    const { chunks, outcome, logs } = await turn(script, 'やあ');
    expect(deltas(chunks)).toEqual(['SAFE']);
    expect(outcome.fallback).toBe('SAFE');
    expect(logs).toContain('agent.turn_error');
  });

  it('falls back when the first token is too slow', async () => {
    const llmDelay = new ScriptedLlm(() => ({ text: 'おそい。' }), { delayMs: 300 });
    const ex = executor();
    const actions: PetAction[] = [];
    const tools = createPetTools(
      ex,
      { childId: 'c_1', sessionId: 's_1', gradeBand: 'high', characterId: 'moko' },
      (a) => actions.push(a),
    );
    const agent = createPetAgent({ model: llmDelay, instruction: 'x', tools });
    const sessionService = new InMemorySessionService();
    await sessionService.createSession({ appName: PET_APP_NAME, userId: 'c_1', sessionId: 's_1' });
    const chunks: TurnChunk[] = [];
    const gen = runPetTurn({
      agent,
      sessionService,
      childId: 'c_1',
      sessionId: 's_1',
      text: 'やあ',
      gradeBand: 'high',
      filter,
      safeReply: 'SAFE',
      actions,
      firstTokenTimeoutMs: 50,
    });
    let r = await gen.next();
    while (!r.done) {
      chunks.push(r.value);
      r = await gen.next();
    }
    expect(deltas(chunks)).toEqual(['SAFE']);
  });

  it('logs which tools the model chose in a turn, by name only', async () => {
    const turns: Record<string, unknown>[] = [];
    const { outcome } = await turn(petDemoScript(), 'やあ', {
      onLog: (event, fields) => {
        if (event === 'agent.turn') turns.push(fields as Record<string, unknown>);
      },
    });
    expect(turns).toHaveLength(1);
    expect(turns[0]!['tools']).toEqual(outcome.toolCalls);
    expect(turns[0]!['toolCalls']).toBe(outcome.toolCalls.length);
    expect(JSON.stringify(turns[0])).not.toContain('やあ');
  });

  it('never logs child text', async () => {
    const fields: Record<string, unknown>[] = [];
    await turn(petDemoScript(), 'ひみつのことば', { onLog: (_e, f) => fields.push(f) });
    expect(JSON.stringify(fields)).not.toContain('ひみつのことば');
  });

  it('does not expose model thought parts as child-facing text', async () => {
    const model = new ScriptedLlm(() => ({ text: '' }));
    model.generateContentAsync = async function* () {
      yield {
        content: { role: 'model', parts: [{ text: 'PRIVATE_THOUGHT。', thought: true }] },
        partial: true,
      };
      yield { content: { role: 'model', parts: [{ text: 'そっか。' }] }, turnComplete: true };
    };
    const agent = createPetAgent({ model, instruction: 'x', tools: [] });
    const { chunks, outcome } = await turn(() => ({ text: '' }), 'やあ', { agent });
    expect(deltas(chunks).join('')).toBe('そっか。');
    expect(outcome.replyText).not.toContain('PRIVATE_THOUGHT');
  });

  it('does not log provider error messages containing private prompts', async () => {
    const fields: Record<string, unknown>[] = [];
    await turn(
      () => {
        throw new Error('provider echoed ひみつのことば');
      },
      'ひみつのことば',
      {
        onLog: (_e, f) => fields.push(f),
      },
    );
    expect(JSON.stringify(fields)).not.toMatch(/ひみつ|provider echoed/);
    expect(fields).toContainEqual({ error: 'model_event_error' });
  });
});
