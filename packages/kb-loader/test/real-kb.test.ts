import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CHARACTER_IDS, GRADE_BANDS } from '@ijime/api-types';
import { describe, expect, it } from 'vitest';

import { Kb } from '../src/kb.js';
import {
  bannedWordsSchema,
  childRepliesSchema,
  contextKeywordsSchema,
  featuresSchema,
  holidaysSchema,
  hotlinesSchema,
  islandGeometrySchema,
  lexiconSchema,
  moodScoresSchema,
  openingsSchema,
  outputFilterSchema,
  safeRepliesSchema,
  riskRulesSchema,
  schoolCalendarsSchema,
  signalDefinitionSchema,
  weeklyReportSentencesSchema,
} from '../src/schemas.js';
import { FsKbSource } from '../src/source.js';
import { validateKnowledgeBase } from '../src/validate.js';
import { islandCatalogSchema, loadGames, storyRequestsSchema } from '../src/games.js';

const KB_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../kb/v0.1.0');

describe('kb/v0.1.0', () => {
  it('passes manifest verification', async () => {
    const kb = await Kb.load(new FsKbSource(KB_DIR));
    expect(kb.version).toBe('0.1.0');
  });

  it('every YAML file matches its schema', async () => {
    const kb = await Kb.load(new FsKbSource(KB_DIR));
    const lexicon = await kb.yaml('lexicon/ja.yaml', lexiconSchema);
    expect(lexicon.categories.find((c) => c.id === 'crisis')?.expressions).toContain('死にたい');
    const rules = await kb.yaml('rules/risk_rules.yaml', riskRulesSchema);
    expect(rules.cold_start_days).toBe(28);
    for (const p of kb.paths('signals/').filter((p) => p.endsWith('.yaml'))) {
      await kb.yaml(p, signalDefinitionSchema);
    }
    await kb.yaml('games/story_prompts.yaml', storyRequestsSchema);
    await loadGames(kb);
    await kb.yaml('templates/notifications/banned.yaml', bannedWordsSchema);
    await kb.yaml('templates/weekly_report.ja.yaml', weeklyReportSentencesSchema);
    await kb.yaml('rules/output_filter.yaml', outputFilterSchema);
    await kb.yaml('prompts/openings.yaml', openingsSchema);
    await kb.yaml('prompts/safe_replies.yaml', safeRepliesSchema);
    await kb.yaml('templates/voice_retry.ja.yaml', safeRepliesSchema);
    const hotlines = await kb.yaml('resources/hotlines.yaml', hotlinesSchema);
    expect(hotlines.resources).toHaveLength(4);
    expect(hotlines.candidates.length).toBeGreaterThanOrEqual(4);
    const holidays = await kb.yaml('resources/jp_holidays.yaml', holidaysSchema);
    expect(holidays.holidays.map((h) => h.date)).toContain('2026-11-23');
    expect(holidays.holidays.map((h) => h.date)).toContain('2028-11-23');
    expect(holidays.holidays.find((h) => h.date === '2028-03-20')?.estimated).toBe(true);
    await kb.yaml('resources/school_calendars.yaml', schoolCalendarsSchema);
    const registry = await validateKnowledgeBase(kb);
    expect(registry.sources.length).toBeGreaterThan(10);
    const keywords = await kb.yaml('rules/context_keywords.yaml', contextKeywordsSchema);
    expect(keywords.categories.map((c) => c.category)).toContain('exam');
    await kb.yaml('templates/child_replies.ja.yaml', childRepliesSchema);
    const mood = await kb.yaml('rules/mood_scores.yaml', moodScoresSchema);
    expect(mood.scores).toEqual({ sunny: 3, cloudy: 2, rainy: 1, stormy: 0 });
    const geometry = await kb.yaml('rules/island_geometry.yaml', islandGeometrySchema);
    const { items } = await kb.yaml('games/island_items.yaml', islandCatalogSchema);
    for (const c of geometry.figure_categories)
      expect(
        items.some((i) => i.category === c),
        c,
      ).toBe(true);
  });

  it('daily features only use metrics that rule signals produce', async () => {
    const kb = await Kb.load(new FsKbSource(KB_DIR));
    const metrics = new Set<string>();
    for (const p of kb.paths('signals/').filter((p) => p.endsWith('.yaml'))) {
      const s = await kb.yaml(p, signalDefinitionSchema);
      if (s.method === 'rule' && s.metric) metrics.add(s.metric);
    }
    const { features } = await kb.yaml('rules/features.yaml', featuresSchema);
    for (const f of features) {
      if ('metric' in f.source) expect(metrics.has(f.source.metric), f.name).toBe(true);
    }
    const rules = await kb.yaml('rules/risk_rules.yaml', riskRulesSchema);
    expect(features.map((f) => f.name)).toContain(rules.daily.school_avoidance.feature);
  });

  it('has a prompt file for every character and grade band', async () => {
    const kb = await Kb.load(new FsKbSource(KB_DIR));
    for (const c of CHARACTER_IDS) expect(kb.has(`prompts/persona/${c}.md`), c).toBe(true);
    for (const g of GRADE_BANDS) {
      expect(kb.has(`prompts/grade/${g}.md`), g).toBe(true);
      expect(kb.has(`templates/safe_mode/${g}.ja.txt`), g).toBe(true);
    }
    expect(kb.has('templates/safe_mode/family_harm.ja.txt')).toBe(true);
    for (const p of [
      'charter',
      'status',
      'voice',
      'crisis_review',
      'signal_extract',
      'artwork_feature',
      'notification_writer',
    ]) {
      expect(kb.has(`prompts/${p}.md`), p).toBe(true);
    }
  });

  it('charter keeps the twelve promises and the petName placeholder', async () => {
    const kb = await Kb.load(new FsKbSource(KB_DIR));
    const charter = await kb.text('prompts/charter.md');
    expect(charter).toContain('{petName}');
    expect(charter.match(/^\d+\. /gm)).toHaveLength(12);
  });

  it('every output schema is valid JSON with required fields', async () => {
    const kb = await Kb.load(new FsKbSource(KB_DIR));
    for (const p of kb.paths('schemas/')) {
      const schema = JSON.parse(await kb.text(p)) as { type: string; required?: string[] };
      expect(schema.type, p).toBe('object');
      expect(schema.required?.length, p).toBeGreaterThan(0);
    }
  });
});
