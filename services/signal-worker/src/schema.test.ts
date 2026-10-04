import { readFile } from 'node:fs/promises';

import { checkSchema, type JsonSchema } from '@ijime/agent-core';
import { describe, expect, it } from 'vitest';

import { matchEvidence } from './evidence.js';
import type { ArtworkFeatures, ExtractOutput, IslandStory } from './rules.js';

const quote = '昨日ぼくがたたかれた。';
const attribution = {
  contextKind: 'self_report',
  evidence: [{ source: 'current', turnIndex: 0, quote }],
};
async function schema(name: string): Promise<JsonSchema> {
  return JSON.parse(
    await readFile(new URL(`../../../kb/v0.1.0/schemas/${name}.json`, import.meta.url), 'utf8'),
  );
}

describe('attribution schema compatibility', () => {
  it('accepts old signal outputs but never grants explicit status from missing attribution', async () => {
    const checked = checkSchema<ExtractOutput>(await schema('signal_extract'), {
      signals: [{ signalDefId: 'A-EXCL-003', value: 0.9, explicit: true }],
      valence: 0,
      topics: [],
      schoolAvoidance: false,
    });
    expect(checked.ok).toBe(true);
    if (checked.ok)
      expect(matchEvidence(checked.value.signals[0]!, { current: quote }).eligible).toBe(false);
  });

  it('accepts grounded attribution and rejects malformed roles, indexes and context kinds', async () => {
    const s = await schema('signal_extract');
    const wrap = (extra: unknown) => ({
      signals: [{ signalDefId: 'A-EXCL-003', value: 0.9, explicit: true, ...(extra as object) }],
      valence: 0,
      topics: [],
      schoolAvoidance: false,
    });
    expect(checkSchema(s, wrap(attribution)).ok).toBe(true);
    for (const invalid of [
      { ...attribution, contextKind: 'definitely_real' },
      { ...attribution, evidence: [{ source: 'pet', turnIndex: 0, quote }] },
      { ...attribution, evidence: [{ source: 'current', turnIndex: -1, quote }] },
      { ...attribution, evidence: [{ source: 'prior', turnIndex: 3, quote }] },
      { ...attribution, evidence: [{ source: 'current', turnIndex: 0 }] },
    ])
      expect(checkSchema(s, wrap(invalid)).ok).toBe(false);
  });

  it.each(['artwork_feature', 'island_narrative'])(
    'bounds %s evidence to the actual narrative',
    async (name) => {
      const s = await schema(name);
      const legacy =
        name === 'artwork_feature'
          ? { selfPresent: true, othersCount: 0, explicitHarm: true }
          : { storyOutcome: 'negative', explicitHarm: true };
      const old = checkSchema<ArtworkFeatures | IslandStory>(s, legacy);
      expect(old.ok).toBe(true);
      if (old.ok) expect(matchEvidence(old.value, { current: quote }).eligible).toBe(false);
      expect(checkSchema(s, { ...legacy, ...attribution }).ok).toBe(true);
      expect(
        checkSchema(s, {
          ...legacy,
          ...attribution,
          evidence: [{ source: 'prior', turnIndex: 0, quote }],
        }).ok,
      ).toBe(false);
    },
  );
});
