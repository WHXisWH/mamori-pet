import { fileURLToPath } from 'node:url';
import { ScriptedLlm } from '@ijime/agent-core';
import { FsKbSource, Kb, lexiconSchema } from '@ijime/kb-loader';
import { beforeAll, describe, expect, it } from 'vitest';
import { KeywordMatcher } from './keyword.js';
import { createModelDetector, createRuntimeDetector } from './model.js';
import { ModelCallError, type ModelEvent } from './detector.js';

let kb: Kb;
let keywords: KeywordMatcher;
beforeAll(async () => {
  kb = await Kb.load(new FsKbSource(fileURLToPath(new URL('../../../kb/v0.1.0', import.meta.url))));
  keywords = KeywordMatcher.fromLexicon(await kb.yaml('lexicon/ja.yaml', lexiconSchema));
});
const llm = (value: unknown) => new ScriptedLlm(() => ({ text: JSON.stringify(value) }));
const input = { text: 'きえたい', gradeBand: 'low' as const, priorTurns: [] };

describe('ADK crisis classifier contract', () => {
  it('distinguishes privacy boundaries from danger while retaining prior-turn harm evidence', async () => {
    const screenModel = llm({ suspect: true });
    const reviewModel = llm({ hit: false, category: 'none', confidence: 0.9 });
    const detector = createModelDetector({ kb, screenModel, reviewModel }, keywords);
    await detector.check({
      text: '家の人に送らないで',
      gradeBand: 'high',
      priorTurns: ['今日は寂しかった'],
    });
    expect(JSON.stringify(screenModel.requests[0]?.config?.systemInstruction)).toContain(
      '希望だけは',
    );
    const prompt = JSON.stringify(reviewModel.requests[0]?.config?.systemInstruction);
    expect(prompt).toContain('共有の拒否だけを evidenceSpan');
    expect(prompt).toContain('前の発言に危害があれば');
  });
  it('does not attach arbitrary error text to model diagnostics', () => {
    const error = new ModelCallError('error', 'private child input' as never);
    expect(error.reason).toBeUndefined();
    expect(error.message).toBe('crisis_model_error');
  });

  it.each([
    ['invalid_json', 'not JSON'],
    ['schema', '{"hit":true}'],
    ['inconsistent_verdict', '{"hit":true,"category":"none","confidence":0.9}'],
  ])(
    'distinguishes %s from other review failures without releasing the input',
    async (reason, text) => {
      const events: ModelEvent[] = [];
      const detector = createModelDetector(
        { kb, screenModel: llm({ suspect: true }), reviewModel: new ScriptedLlm(() => ({ text })) },
        keywords,
        { onModelEvent: (event) => events.push(event) },
      );
      expect(await detector.check(input)).toMatchObject({
        method: 'paused',
        availability: 'unavailable',
      });
      expect(events).toEqual([{ layer: 'review', kind: 'error', reason }]);
    },
  );

  it('asks for one contiguous verbatim excerpt rather than joined source sentences', async () => {
    const reviewModel = llm({ hit: false, category: 'none', confidence: 0.8 });
    const detector = createModelDetector(
      { kb, screenModel: llm({ suspect: true }), reviewModel },
      keywords,
    );
    await detector.check({ ...input, text: '今日は晴れだね' });
    const instruction = reviewModel.requests[0]?.config?.systemInstruction;
    expect(JSON.stringify(instruction)).toContain('一つの連続した部分文字列');
    expect(JSON.stringify(instruction)).toContain('離れた文や別のターンをつなげない');
  });

  it.each([
    ['joined', 'がっこうの はなしは したくない。あそびにも いきたくない。'],
    ['whitespace_changed', 'がっこうのはなしはしたくない。'],
    ['invented', 'いじめられた'],
    ['empty', ''],
  ])(
    'keeps %s evidence paused and reports only an enumerated reason',
    async (_name, evidenceSpan) => {
      const events: ModelEvent[] = [];
      const text =
        'がっこうの はなしは したくない。べつの はなしが いい。あそびにも いきたくない。';
      const detector = createModelDetector(
        {
          kb,
          screenModel: llm({ suspect: true }),
          reviewModel: llm({ hit: true, category: 'other', confidence: 0.8, evidenceSpan }),
        },
        keywords,
        { onModelEvent: (event) => events.push(event) },
      );
      expect(await detector.check({ ...input, text })).toMatchObject({
        method: 'paused',
        availability: 'unavailable',
        hit: false,
      });
      expect(events).toEqual([{ layer: 'review', kind: 'error', reason: 'invalid_evidence' }]);
      expect(JSON.stringify(events)).not.toContain(text);
      expect(JSON.stringify(events)).not.toContain('evidenceSpan');
    },
  );

  it('accepts an exact contiguous excerpt with its original spacing', async () => {
    const text = 'がっこうの はなしは したくない。べつの はなしが いい。';
    const evidenceSpan = 'がっこうの はなしは したくない。';
    const detector = createModelDetector(
      {
        kb,
        screenModel: llm({ suspect: true }),
        reviewModel: llm({ hit: true, category: 'other', confidence: 0.8, evidenceSpan }),
      },
      keywords,
    );
    expect(await detector.check({ ...input, text })).toMatchObject({
      availability: 'verified',
      hit: true,
      category: 'other',
      evidenceSpan,
    });
  });
  it('runs structured semantic screen and evidence-backed review', async () => {
    const screenModel = llm({ suspect: true });
    const reviewModel = llm({
      hit: true,
      category: 'self_harm',
      confidence: 0.9,
      evidenceSpan: input.text,
    });
    const detector = createModelDetector({ kb, screenModel, reviewModel }, keywords);
    expect(await detector.check(input)).toMatchObject({
      hit: true,
      category: 'self_harm',
      availability: 'verified',
      familyHarmSuspected: false,
    });
    expect(reviewModel.requests).toHaveLength(1);
    expect(reviewModel.requests[0]?.config?.tools ?? []).toHaveLength(0);
  });
  it.each([
    { hit: true, category: 'none', confidence: 0.9 },
    {
      hit: true,
      category: 'violence',
      confidence: 0.9,
      evidenceSpan: 'invented quote',
    },
    { invalid: true },
  ])('never treats an invalid review as clearance: %j', async (value) => {
    const detector = createModelDetector(
      { kb, screenModel: llm({ suspect: true }), reviewModel: llm(value) },
      keywords,
    );
    expect(await detector.check(input)).toMatchObject({
      hit: false,
      method: 'paused',
      availability: 'unavailable',
      familyHarmSuspected: false,
    });
  });
  it('falls through a malformed screen into independent review', async () => {
    const reviewModel = llm({
      hit: false,
      category: 'none',
      confidence: 0.8,
    });
    const detector = createModelDetector(
      { kb, screenModel: llm({ bogus: false }), reviewModel },
      keywords,
    );
    expect(await detector.check({ ...input, text: '今日は晴れだね' })).toMatchObject({
      hit: false,
      availability: 'verified',
    });
    expect(reviewModel.requests).toHaveLength(1);
  });
  it('rejects production scripted mode and unapproved region', async () => {
    await expect(
      createRuntimeDetector(kb, { NODE_ENV: 'production', CRISIS_MODEL_MODE: 'scripted' }),
    ).rejects.toThrow();
    await expect(
      createRuntimeDetector(kb, {
        CRISIS_MODEL_MODE: 'vertex',
        GCP_PROJECT_ID: 'real-project',
        GCP_REGION: 'global',
      }),
    ).rejects.toThrow('asia-northeast1');
  });
});
