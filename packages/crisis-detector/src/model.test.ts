import { fileURLToPath } from 'node:url';
import { ScriptedLlm } from '@ijime/agent-core';
import { FsKbSource, Kb, lexiconSchema } from '@ijime/kb-loader';
import { beforeAll, describe, expect, it } from 'vitest';
import { KeywordMatcher } from './keyword.js';
import { createModelDetector, createRuntimeDetector } from './model.js';

let kb: Kb;
let keywords: KeywordMatcher;
beforeAll(async () => {
  kb = await Kb.load(new FsKbSource(fileURLToPath(new URL('../../../kb/v0.1.0', import.meta.url))));
  keywords = KeywordMatcher.fromLexicon(await kb.yaml('lexicon/ja.yaml', lexiconSchema));
});
const llm = (value: unknown) => new ScriptedLlm(() => ({ text: JSON.stringify(value) }));
const input = { text: 'きえたい', gradeBand: 'low' as const, priorTurns: [] };

describe('ADK crisis classifier contract', () => {
  it('runs structured semantic screen and evidence-backed review', async () => {
    const screenModel = llm({ suspect: true });
    const reviewModel = llm({
      hit: true,
      category: 'suicidal',
      confidence: 0.9,
      familyHarmSuspected: false,
      evidenceSpan: input.text,
    });
    const detector = createModelDetector({ kb, screenModel, reviewModel }, keywords);
    expect(await detector.check(input)).toMatchObject({
      hit: true,
      availability: 'verified',
      familyHarmSuspected: false,
    });
    expect(reviewModel.requests).toHaveLength(1);
    expect(reviewModel.requests[0]?.config?.tools ?? []).toHaveLength(0);
  });
  it.each([
    { hit: true, category: 'none', confidence: 0.9, familyHarmSuspected: false },
    {
      hit: true,
      category: 'violence',
      confidence: 0.9,
      familyHarmSuspected: false,
      evidenceSpan: 'invented quote',
    },
    { invalid: true },
  ])('never treats an invalid review as clearance: %j', async (value) => {
    const detector = createModelDetector(
      { kb, screenModel: llm({ suspect: true }), reviewModel: llm(value) },
      keywords,
    );
    expect(await detector.check(input)).toMatchObject({
      hit: true,
      availability: 'unavailable',
      familyHarmSuspected: true,
    });
  });
  it('falls through a malformed screen into independent review', async () => {
    const reviewModel = llm({
      hit: false,
      category: 'none',
      confidence: 0.8,
      familyHarmSuspected: false,
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
