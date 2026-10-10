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
  routingOfCheck,
  routingOfRecord,
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
  it.each(['low', 'high', 'jhs'] as const)(
    'keeps child-facing hotlines and adds the existing emergency resource for %s',
    (gradeBand) => {
      const r = crisisResponse({ familyHarmSuspected: false, gradeBand, copy, hotlines });
      expect(r.resources.map((h) => h.id).sort()).toEqual(['childline', 'emergency', 'sos_dial']);
      expect(r.resources.find((h) => h.id === 'emergency')).toBe(
        hotlines.find((h) => h.id === 'emergency'),
      );
      expect(r.message).toBe(safeModeMessage(copy[gradeBand]));
    },
  );

  it.each(['low', 'high', 'jhs'] as const)(
    'keeps child guidance centre and emergency resources for family harm in %s',
    (gradeBand) => {
      const r = crisisResponse({ familyHarmSuspected: true, gradeBand, copy, hotlines });
      expect(r.resources.map((h) => h.id).sort()).toEqual(['emergency', 'jidou_soudan']);
      expect(r.message).toBe(safeModeMessage(copy.family_harm));
    },
  );
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

describe('crisis routing', () => {
  it('maps a check to an event category, defaulting to other', () => {
    expect(routingOfCheck({ category: 'violence' })).toEqual({
      category: 'violence',
      familyHarmSuspected: false,
    });
    expect(routingOfCheck({ category: 'family_harm' })).toEqual({
      category: 'family_harm',
      familyHarmSuspected: true,
    });
    expect(routingOfCheck({ category: 'none' })).toEqual({
      category: 'other',
      familyHarmSuspected: false,
    });
  });

  it('reads stored records and keeps legacy records without category conservative', () => {
    expect(routingOfRecord({ category: 'extortion', familyHarmSuspected: false })).toEqual({
      category: 'extortion',
      familyHarmSuspected: false,
    });
    expect(routingOfRecord({ category: 'family_harm' })).toEqual({
      category: 'family_harm',
      familyHarmSuspected: true,
    });
    expect(routingOfRecord({ familyHarmSuspected: true })).toEqual({
      category: 'family_harm',
      familyHarmSuspected: true,
    });
    expect(routingOfRecord({})).toEqual({ category: 'family_harm', familyHarmSuspected: true });
    expect(routingOfRecord({ familyHarmSuspected: false })).toEqual({
      category: 'other',
      familyHarmSuspected: false,
    });
    expect(routingOfRecord({ category: 'suicidal', familyHarmSuspected: false })).toEqual({
      category: 'other',
      familyHarmSuspected: false,
    });
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
        category: 'self_harm',
        familyHarmSuspected: false,
        method: 'review',
        keywordMatched: true,
        confidence: 0.5,
        latencyMs: 3,
        evidenceSpan: '死にたい',
      },
      now,
    });
    expect(doc).toMatchObject({
      triggerType: 'voice',
      status: 'open',
      category: 'self_harm',
      familyHarmSuspected: false,
    });
    expect(JSON.stringify(doc)).not.toContain('死にたい');
  });
});
