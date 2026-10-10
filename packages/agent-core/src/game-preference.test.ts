import { createEvent, InMemorySessionService } from '@google/adk';
import { FsKbSource, Kb } from '@ijime/kb-loader';
import type { PetAction } from '@ijime/api-types';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { createPetAgent } from './agent.js';
import { createPetCallbacks } from './callbacks.js';
import { PET_APP_NAME } from './firestore-session.js';
import { OutputFilter } from './output-filter.js';
import { ScriptedLlm } from './scripted-llm.js';
import { createPetTools, type PetToolExecutor } from './tools.js';
import { runPetTurn } from './turn.js';
import { gamePreferenceChange, loadGamePreferenceRules } from './game-preference.js';

let kb: Kb;
const filter = new OutputFilter({ rules: [] });
beforeAll(async () => {
  kb = await Kb.load(new FsKbSource(new URL('../../../kb/v0.1.0', import.meta.url).pathname));
});

async function preferenceTurn(
  sessionService: Parameters<typeof runPetTurn>[0]['sessionService'],
  sessionId: string,
  text: string,
  options: {
    childId?: string;
    messageId?: string;
    tryGame?: boolean;
    alsoHelp?: boolean;
    usageTail?: boolean;
  } = {},
) {
  const actions: PetAction[] = [];
  const suggestGame = vi.fn(async () => ({ requestId: 'test-request' }));
  const executor = { suggestGame } as unknown as PetToolExecutor;
  const childId = options.childId ?? 'child';
  const rules = await loadGamePreferenceRules(kb);
  const change = gamePreferenceChange(text, rules);
  if (change !== undefined) {
    const session = await sessionService.getSession({
      appName: PET_APP_NAME,
      userId: childId,
      sessionId,
    });
    await sessionService.appendEvent({
      session: session!,
      event: createEvent({
        author: 'system',
        actions: { stateDelta: { gameSuggestionsDeclined: change } },
      }),
    });
  }
  let result: unknown;
  let attempt = 0;
  const model = new ScriptedLlm(({ toolResults }) => {
    if (options.tryGame !== false && attempt++ === 0)
      return {
        calls: [
          { name: 'suggest_game', args: { type: 'drawing' } },
          ...(options.alsoHelp ? [{ name: 'show_help_resources', args: {} }] : []),
        ],
      };
    result = toolResults.at(-1)?.response;
    return { text: 'もこの しまは、きょうは はれだよ。' };
  });
  if (options.usageTail) {
    const generate = model.generateContentAsync.bind(model);
    model.generateContentAsync = async function* (request, stream) {
      let hadTool = false;
      for await (const response of generate(request, stream)) {
        hadTool ||= response.content?.parts?.some((part) => part.functionCall) === true;
        yield response;
      }
      if (hadTool) yield { usageMetadata: { totalTokenCount: 1 } };
    };
  }
  const agent = createPetAgent({
    model,
    instruction: 'test',
    tools: createPetTools(
      executor,
      { childId, sessionId, gradeBand: 'low', characterId: 'moko' },
      (a) => actions.push(a),
    ),
    ...createPetCallbacks({
      filter,
      safeReply: 'SAFE',
      gamePreferenceRules: rules,
    }),
  });
  const gen = runPetTurn({
    agent,
    sessionService,
    childId,
    sessionId,
    text,
    ...(options.messageId ? { messageId: options.messageId } : {}),
    gradeBand: 'low',
    filter,
    safeReply: 'SAFE',
    actions,
  });
  let next = await gen.next();
  while (!next.done) next = await gen.next();
  expect(next.value.fallback).toBeNull();
  const session = await sessionService.getSession({
    appName: PET_APP_NAME,
    userId: childId,
    sessionId,
  });
  return { actions, suggestGame, result, model, state: session!.state };
}

describe('session-scoped game preference', () => {
  async function fixture() {
    const sessions = new InMemorySessionService();
    await sessions.createSession({ appName: PET_APP_NAME, userId: 'child', sessionId: 'chat' });
    return sessions;
  }

  it('continues generation after a Gemini tool-call usage-only tail', async () => {
    const turn = await preferenceTurn(await fixture(), 'chat', 'ゲームはしたくない。', {
      usageTail: true,
    });
    expect(turn.model.requests).toHaveLength(2);
    expect(turn.suggestGame).not.toHaveBeenCalled();
  });

  it('keeps a refusal across new agents and ordinary follow-ups until an explicit request', async () => {
    const sessions = await fixture();
    for (const text of [
      'がっこうの はなしは したくない。あそびにも いきたくない。',
      'べつの はなしをしたい',
      'うん。',
      'もこの しまの そらは なにいろ？',
      'ともだちが「あそびたい」といっていた。',
    ]) {
      const turn = await preferenceTurn(sessions, 'chat', text);
      expect(turn.suggestGame).not.toHaveBeenCalled();
      expect(turn.actions).toEqual([]);
      expect(turn.result).toMatchObject({ error: 'game_declined' });
      expect(turn.state).toMatchObject({ gameSuggestionsDeclined: true });
      expect(JSON.stringify(turn.state)).not.toContain(text);
      expect(JSON.stringify(turn.model.requests[0]?.config?.systemInstruction)).toContain(
        '普通のおしゃべり',
      );
    }
    const changed = await preferenceTurn(
      sessions,
      'chat',
      'いまは ゲームで あそびたい。おえかきを したい。',
    );
    expect(changed.suggestGame).toHaveBeenCalledTimes(1);
    expect(changed.actions).toEqual([
      { type: 'suggest_game', game: 'drawing', requestId: 'test-request' },
    ]);
    expect(changed.state).toMatchObject({ gameSuggestionsDeclined: false });
    const declinedAgain = await preferenceTurn(sessions, 'chat', 'やっぱり ゲームは したくない。');
    expect(declinedAgain.suggestGame).not.toHaveBeenCalled();
  });

  it.each([
    'ゲームはしたくない。',
    '遊びたくない。',
    '今は遊ばない。',
    'あそびにも いきたくない。',
  ])('recognizes a clear refusal without persisting the original: %s', async (text) => {
    const result = await preferenceTurn(await fixture(), 'chat', text);
    expect(result.suggestGame).not.toHaveBeenCalled();
    expect(result.state.gameSuggestionsDeclined).toBe(true);
  });

  it('does not convert topic-change into a permanent refusal or consent', async () => {
    const sessions = await fixture();
    const changed = await preferenceTurn(sessions, 'chat', 'べつの はなしをしたい');
    expect(changed.suggestGame).not.toHaveBeenCalled();
    expect(changed.result).toMatchObject({ error: 'topic_change_is_not_game_consent' });
    expect(changed.state.gameSuggestionsDeclined).toBeUndefined();
    const requested = await preferenceTurn(sessions, 'chat', 'ゲームで遊ぼう。');
    expect(requested.suggestGame).toHaveBeenCalledTimes(1);
  });

  it('persists refusal without any tool call and does not leak into another session', async () => {
    const sessions = await fixture();
    const declined = await preferenceTurn(sessions, 'chat', 'ゲームはしたくない。', {
      tryGame: false,
    });
    expect(declined.state.gameSuggestionsDeclined).toBe(true);
    await sessions.createSession({ appName: PET_APP_NAME, userId: 'child', sessionId: 'other' });
    const other = await preferenceTurn(sessions, 'other', 'こんにちは。');
    expect(other.suggestGame).toHaveBeenCalledTimes(1);
    const first = await preferenceTurn(sessions, 'chat', 'こんにちは。');
    expect(first.suggestGame).not.toHaveBeenCalled();
  });

  it('does not block help resources alongside a denied game', async () => {
    const turn = await preferenceTurn(await fixture(), 'chat', 'ゲームはしたくない。', {
      alsoHelp: true,
    });
    expect(turn.suggestGame).not.toHaveBeenCalled();
    expect(turn.actions).toEqual([{ type: 'show_help_resources' }]);
  });

  it.each([
    '友達が「遊びたくない」と言った。',
    '「ゲームはしたくない。」というせりふを読んだ。',
    '遊びたくないわけじゃない。',
  ])(
    'does not treat quoted, third-party or double-negative speech as a direct refusal: %s',
    async (text) => {
      const turn = await preferenceTurn(await fixture(), 'chat', text);
      expect(turn.state.gameSuggestionsDeclined).toBeUndefined();
    },
  );
});
