import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FsKbSource, Kb, lexiconSchema } from '@ijime/kb-loader';
import { beforeAll, describe, expect, it } from 'vitest';

import { createNoModelDetector } from './no-model.js';
import {
  crisisEventDoc,
  crisisResponse,
  loadHotlines,
  loadSafeModeCopy,
  safeModeMessage,
  type SafeModeCopy,
} from './response.js';
import type { HelpResource } from '@ijime/api-types';

const KB_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../kb/v0.1.0');

let kb: Kb;
let copy: SafeModeCopy;
let hotlines: HelpResource[];
beforeAll(async () => {
  kb = await Kb.load(new FsKbSource(KB_DIR));
  copy = await loadSafeModeCopy(kb);
  hotlines = (await loadHotlines(kb)).resources;
});

describe('crisisResponse', () => {
  it('gives the child-facing hotlines and grade copy normally', () => {
    const r = crisisResponse({ familyHarmSuspected: false, gradeBand: 'low', copy, hotlines });
    expect(r.resources.map((h) => h.id).sort()).toEqual(['childline', 'sos_dial']);
    expect(r.message).toBe(safeModeMessage(copy.low));
  });

  it('gives child guidance centre and police when harm points at the family', () => {
    const r = crisisResponse({ familyHarmSuspected: true, gradeBand: 'jhs', copy, hotlines });
    expect(r.resources.map((h) => h.id).sort()).toEqual(['emergency', 'jidou_soudan']);
    expect(r.message).toBe(safeModeMessage(copy.family_harm));
  });
});

describe('safeModeMessage', () => {
  it('drops adult notes and button hints', () => {
    expect(
      safeModeMessage(['（大人向けの説明）', 'だいじょうぶ？（はい / いいえ）', 'そばにいるよ']),
    ).toBe('だいじょうぶ？\nそばにいるよ');
  });
});

describe('createNoModelDetector', () => {
  it('confirms keyword hits and passes ordinary talk', async () => {
    const d = createNoModelDetector(await kb.yaml('lexicon/ja.yaml', lexiconSchema));
    const hit = await d.check({ text: 'もう死にたい', gradeBand: 'high', priorTurns: [] });
    expect(hit).toMatchObject({ hit: true, keywordMatched: true, method: 'review' });
    const ok = await d.check({
      text: 'きょうは給食がカレーだった',
      gradeBand: 'high',
      priorTurns: [],
    });
    expect(ok.hit).toBe(false);
  });
});

describe('crisisEventDoc', () => {
  it('records detection metadata only, never the text', () => {
    const now = new Date('2026-10-01T00:00:00Z');
    const doc = crisisEventDoc({
      triggerType: 'voice',
      sourceRef: 'families/f/children/c/sessions/s/messages/m',
      check: {
        hit: true,
        category: 'suicidal',
        familyHarmSuspected: false,
        method: 'review',
        keywordMatched: true,
        confidence: 0.5,
        latencyMs: 3,
        evidenceSpan: '死にたい',
      },
      now,
    });
    expect(doc).toMatchObject({ triggerType: 'voice', status: 'open', familyHarmSuspected: false });
    expect(JSON.stringify(doc)).not.toContain('死にたい');
  });
});
