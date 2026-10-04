import { InMemorySessionService } from '@google/adk';
import type { PetAction, TurnChunk } from '@ijime/api-types';
import { describe, expect, it, vi } from 'vitest';
import { createPetAgent } from './agent.js';
import { PET_APP_NAME } from './firestore-session.js';
import { OutputFilter } from './output-filter.js';
import { ScriptedLlm } from './scripted-llm.js';
import { runPetTurn } from './turn.js';

import {
  createPetTools,
  CRISIS_REASONS,
  PET_TOOL_NAMES,
  petToolSchemas,
  type PetToolExecutor,
  type TurnContext,
} from './tools.js';

const ctx: TurnContext = {
  childId: 'c_1',
  sessionId: 's_1',
  gradeBand: 'low',
  characterId: 'moko',
};

function executor(): PetToolExecutor {
  return {
    getChildContext: vi.fn(async () => ({
      gradeBand: 'low' as const,
      characterId: 'moko' as const,
      localTime: '2026-09-29 16:00',
      dayType: 'school_day' as const,
      recentTrend: '',
      careFlag: false,
    })),
    searchSkill: vi.fn(async () => ['a', 'b', 'c', 'd']),
    recordMood: vi.fn(async () => {}),
    remember: vi.fn(async () => ({ memoryId: 'm_1' })),
    recall: vi.fn(async () => ['x', 'y', 'z', 'w', 'v', 'u']),
    suggestGame: vi.fn(async () => true),
    startTellAdult: vi.fn(async () => ({ consultationId: 'cs_1' })),
    escalateCrisis: vi.fn(async () => ({ crisisId: 'cr_1' })),
  };
}

describe('pet tools', () => {
  it('declares the 11 tools from the API doc with matching names', () => {
    const ex = executor();
    const tools = createPetTools(ex, ctx, () => {});
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...PET_TOOL_NAMES].sort());
    expect(names).toHaveLength(11);
    for (const t of tools) {
      const decl = t._getDeclaration();
      expect(decl.name).toBe(t.name);
      expect(decl.description?.length).toBeGreaterThan(0);
    }
  });

  it('defines violence as current or imminent physical danger, not exclusion alone', () => {
    const tool = createPetTools(executor(), ctx, () => {}).find(
      (t) => t.name === 'escalate_crisis',
    )!;
    const description = tool._getDeclaration().description!;
    expect(description).toContain('現在続いている・差し迫った身体的暴力');
    expect(description).toContain('家庭内を含む');
    expect(description).toContain('仲間外れ・無視・口げんかだけを violence と扱わない');
    expect(description).toContain('search_skill');
    expect(description).toContain('show_help_resources');
    expect(description).toContain('しにたい');
    expect(description).toContain('創作や引用だけ');
    expect(description).toContain('本人の現在の危険');
    expect(description).toContain('証明や同意を待たない');
  });

  it('requires requested help UI before prose and distinguishes it from skill retrieval', () => {
    const tools = createPetTools(executor(), ctx, () => {});
    const description = (name: string) =>
      tools.find((tool) => tool.name === name)!._getDeclaration().description!;
    expect(description('show_help_resources')).toContain('相談窓口・連絡先を見せて');
    expect(description('show_help_resources')).toContain('返答文を出す前に必ず呼ぶ');
    expect(description('show_help_resources')).toContain('search_skill と同じターン');
    expect(description('show_help_resources')).toContain('説明文だけでは画面に表示されない');
    expect(description('search_skill')).toContain('相談窓口を表示するツールではない');
    expect(description('search_skill')).toContain('show_help_resources も呼ぶ');
  });

  it('delivers scripted requested help before a long reply reaches the character limit', async () => {
    const ex = executor();
    const actions: PetAction[] = [];
    const helpCtx: TurnContext = { ...ctx, gradeBand: 'high' };
    const model = new ScriptedLlm(({ toolResults }) =>
      toolResults.length
        ? { text: '話してくれてありがとう。'.repeat(20) }
        : {
            calls: [
              { name: 'set_expression', args: { expression: 'caring' } },
              { name: 'search_skill', args: { query: '友だちとのけんか' } },
              { name: 'show_help_resources', args: {} },
            ],
          },
    );
    const agent = createPetAgent({
      model,
      instruction: 'test',
      tools: createPetTools(ex, helpCtx, (action) => actions.push(action)),
    });
    const sessionService = new InMemorySessionService();
    await sessionService.createSession({
      appName: PET_APP_NAME,
      userId: ctx.childId,
      sessionId: ctx.sessionId,
    });
    const chunks: TurnChunk[] = [];
    for await (const chunk of runPetTurn({
      agent,
      sessionService,
      childId: ctx.childId,
      sessionId: ctx.sessionId,
      text: '接し方を調べて、相談窓口も見せて。',
      gradeBand: 'high',
      filter: new OutputFilter({ rules: [] }),
      safeReply: 'SAFE',
      actions,
    }))
      chunks.push(chunk);
    const helpIndex = chunks.findIndex(
      (chunk) => chunk.type === 'action' && chunk.action.type === 'show_help_resources',
    );
    expect(helpIndex).toBeGreaterThanOrEqual(0);
    expect(helpIndex).toBeLessThan(chunks.findIndex((chunk) => chunk.type === 'delta'));
    expect(
      chunks
        .filter((chunk) => chunk.type === 'delta')
        .map((chunk) => chunk.text)
        .join('').length,
    ).toBeLessThanOrEqual(100);
    expect(chunks.at(-1)?.type).toBe('done');
    expect(ex.searchSkill).toHaveBeenCalledOnce();
    expect(ex.startTellAdult).not.toHaveBeenCalled();
    expect(ex.escalateCrisis).not.toHaveBeenCalled();
  });

  it.each(CRISIS_REASONS)(
    'keeps %s available without consent or an ordinary tool budget',
    async (reason) => {
      const ex = executor();
      const tool = createPetTools(ex, ctx, () => {}, undefined, { maxToolCalls: 0 }).find(
        (t) => t.name === 'escalate_crisis',
      )!;
      expect(await tool.runAsync({ args: { reason }, toolContext: {} as never })).toEqual({
        crisisId: 'cr_1',
      });
      expect(ex.escalateCrisis).toHaveBeenCalledWith(ctx, reason);
    },
  );

  it('front-end action tools emit PetAction and reserve game suggestions', async () => {
    const ex = executor();
    const actions: PetAction[] = [];
    const tools = createPetTools(ex, ctx, (a) => actions.push(a));
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    await byName['set_expression']!.runAsync({
      args: { expression: 'caring' },
      toolContext: {} as never,
    });
    await byName['offer_quick_replies']!.runAsync({
      args: { options: ['はれ', 'くもり'] },
      toolContext: {} as never,
    });
    await byName['show_help_resources']!.runAsync({ args: {}, toolContext: {} as never });
    await byName['suggest_game']!.runAsync({ args: { type: 'drawing' }, toolContext: {} as never });
    expect(actions).toEqual([
      { type: 'set_expression', expression: 'caring' },
      { type: 'quick_replies', options: ['はれ', 'くもり'] },
      { type: 'show_help_resources' },
      { type: 'suggest_game', game: 'drawing' },
    ]);
    expect(ex.recordMood).not.toHaveBeenCalled();
    expect(ex.suggestGame).toHaveBeenCalledWith(ctx, 'drawing');
  });

  it('does not emit a game at the weekly limit and keeps help available', async () => {
    const ex = executor();
    ex.suggestGame = vi.fn(async () => false);
    const actions: PetAction[] = [];
    const tools = createPetTools(ex, ctx, (a) => actions.push(a));
    const run = (name: string, args: Record<string, unknown>) =>
      tools.find((t) => t.name === name)!.runAsync({ args, toolContext: {} as never });
    expect(await run('suggest_game', { type: 'drawing' })).toEqual({
      error: 'game_suggestion_limit',
    });
    expect(actions).toEqual([]);
    expect(await run('show_help_resources', {})).toEqual({ ok: true });
    expect(await run('start_tell_adult', {})).toEqual({ consultationId: 'cs_1' });
    expect(await run('escalate_crisis', { reason: 'violence' })).toEqual({ crisisId: 'cr_1' });
  });

  it('fails closed on an unavailable game reservation', async () => {
    const ex = executor();
    ex.suggestGame = vi.fn(async () => {
      throw new Error('unavailable');
    });
    const actions: PetAction[] = [];
    const tool = createPetTools(
      ex,
      ctx,
      (a) => actions.push(a),
      () => ({ error: 'tool_unavailable' }),
    ).find((t) => t.name === 'suggest_game')!;
    expect(await tool.runAsync({ args: { type: 'drawing' }, toolContext: {} as never })).toEqual({
      error: 'tool_unavailable',
    });
    expect(actions).toEqual([]);
  });

  it('data tools delegate to the executor and cap list sizes', async () => {
    const ex = executor();
    const actions: PetAction[] = [];
    const byName = Object.fromEntries(
      createPetTools(ex, ctx, (a) => actions.push(a), undefined, { maxToolCalls: 10 }).map((t) => [
        t.name,
        t,
      ]),
    );
    expect(
      await byName['search_skill']!.runAsync({
        args: { query: '無視された' },
        toolContext: {} as never,
      }),
    ).toEqual({
      passages: ['a', 'b', 'c'],
    });
    expect(
      await byName['recall']!.runAsync({ args: { topic: '学校' }, toolContext: {} as never }),
    ).toEqual({
      memories: ['x', 'y', 'z', 'w', 'v'],
    });
    await byName['record_mood']!.runAsync({ args: { weather: 'rainy' }, toolContext: {} as never });
    expect(ex.recordMood).toHaveBeenCalledWith(ctx, 'rainy');
    expect(
      await byName['remember']!.runAsync({
        args: { content: 'ねこが すき', category: 'like' },
        toolContext: {} as never,
      }),
    ).toEqual({
      memoryId: 'm_1',
    });
    expect(
      await byName['start_tell_adult']!.runAsync({ args: {}, toolContext: {} as never }),
    ).toEqual({
      consultationId: 'cs_1',
    });
    expect(actions).toEqual([{ type: 'offer_tell_adult', consultationId: 'cs_1' }]);
    expect(
      await byName['escalate_crisis']!.runAsync({
        args: { reason: 'suicidal' },
        toolContext: {} as never,
      }),
    ).toEqual({
      crisisId: 'cr_1',
    });
    expect(ex.escalateCrisis).toHaveBeenCalledWith(ctx, 'suicidal');
  });

  it('turns executor failures into a model-visible result when onToolError is given', async () => {
    const ex = executor();
    ex.recall = vi.fn(async () => {
      throw new Error('pet-agent 503');
    });
    const seen: string[] = [];
    const tools = createPetTools(
      ex,
      ctx,
      () => {},
      (name) => {
        seen.push(name);
        return { error: 'unavailable' };
      },
    );
    const recall = tools.find((t) => t.name === 'recall')!;
    expect(await recall.runAsync({ args: { topic: '学校' }, toolContext: {} as never })).toEqual({
      error: 'unavailable',
    });
    expect(seen).toEqual(['recall']);
    const bare = createPetTools(ex, ctx, () => {}).find((t) => t.name === 'recall')!;
    await expect(
      bare.runAsync({ args: { topic: '学校' }, toolContext: {} as never }),
    ).rejects.toThrow('503');
  });

  it('schemas reject bad arguments', () => {
    expect(petToolSchemas.offer_quick_replies.safeParse({ options: ['a'] }).success).toBe(false);
    expect(
      petToolSchemas.offer_quick_replies.safeParse({ options: ['a', 'b', 'c', 'd'] }).success,
    ).toBe(false);
    expect(petToolSchemas.escalate_crisis.safeParse({ reason: 'sad' }).success).toBe(false);
    expect(petToolSchemas.record_mood.safeParse({ weather: 'snowy' }).success).toBe(false);
    expect(petToolSchemas.set_expression.safeParse({ expression: 'angry' }).success).toBe(false);
  });

  it('counts individual tool calls and keeps safety tools available after exhaustion', async () => {
    const ex = executor();
    const tools = createPetTools(ex, ctx, () => {});
    const run = (name: string, args: Record<string, unknown>) =>
      tools.find((t) => t.name === name)!.runAsync({ args, toolContext: {} as never });
    await run('recall', { topic: '学校' });
    await run('recall', { topic: '友達' });
    await run('recall', { topic: '家' });
    expect(await run('record_mood', { weather: 'rainy' })).toEqual({
      error: 'tool_budget_exhausted',
    });
    expect(ex.recordMood).not.toHaveBeenCalled();
    expect(await run('escalate_crisis', { reason: 'violence' })).toEqual({ crisisId: 'cr_1' });
    expect(await run('start_tell_adult', {})).toEqual({ consultationId: 'cs_1' });
    expect(await run('show_help_resources', {})).toEqual({ ok: true });
  });

  it('blocks unsafe action text before emitting an action', async () => {
    const actions: PetAction[] = [];
    const filter = new OutputFilter({
      rules: [{ id: 'secret', label_ja: 'x', patterns: ['絶対秘密'] }],
    });
    const tool = createPetTools(executor(), ctx, (a) => actions.push(a), undefined, {
      filter,
    }).find((t) => t.name === 'offer_quick_replies')!;
    expect(
      await tool.runAsync({ args: { options: ['絶対秘密', 'あとで'] }, toolContext: {} as never }),
    ).toEqual({ error: 'output_blocked' });
    expect(actions).toEqual([]);
  });

  it('returns a pending proposal and emits the confirmation action', async () => {
    const ex = executor();
    ex.remember = vi.fn(async () => ({ proposalId: 'p_1', status: 'pending' as const }));
    const actions: PetAction[] = [];
    const tool = createPetTools(ex, ctx, (a) => actions.push(a)).find(
      (t) => t.name === 'remember',
    )!;
    expect(
      await tool.runAsync({
        args: { content: 'ねこが すき', category: 'like' },
        toolContext: {} as never,
      }),
    ).toEqual({ proposalId: 'p_1', status: 'pending' });
    expect(actions).toEqual([
      { type: 'memory_proposal', proposalId: 'p_1', text: 'ねこが すき', category: 'like' },
    ]);
  });
});
