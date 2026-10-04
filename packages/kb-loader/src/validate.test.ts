import { describe, expect, it } from 'vitest';

import { KbIntegrityError } from './kb.js';
import {
  hotlinesSchema,
  lexiconSchema,
  schoolCalendarsSchema,
  signalDefinitionSchema,
  sourceRegistrySchema,
  type Lexicon,
  type SignalDefinition,
} from './schemas.js';
import {
  normalizeExpression,
  validateHotlines,
  validateLexicon,
  validateSignalDefinition,
} from './validate.js';

const known = new Set(['mext_problem_behavior_survey', 'doc_prd']);

const baseSignal = {
  signal_id: 'A-TEST-001',
  domain: 'a',
  description: 'test',
  grade_bands: ['low', 'high', 'jhs'],
  explicit: true,
  evidence: { sources: ['mext_problem_behavior_survey'], strength: 'medium' },
  reviewed_by: '未定',
};

const grouped = {
  low: ['なかまに いれてくれない'],
  high: ['ハブられた'],
  jhs: ['既読スルーされる', 'ハブられた'],
};

function signal(overrides: Record<string, unknown>): SignalDefinition {
  return signalDefinitionSchema.parse({ ...baseSignal, examples_ja: grouped, ...overrides });
}

describe('source registry schema', () => {
  const entry = {
    id: 'mext_problem_behavior_survey',
    title: 't',
    publisher: 'p',
    url: 'https://www.mext.go.jp/',
    year: null,
    accessed_on: null,
    license: 'l',
    strength: 'high',
    verified: false,
    notes: '',
  };

  it('accepts unverified entries and rejects duplicate ids', () => {
    const ok = sourceRegistrySchema.safeParse({
      version: '1',
      reviewed_by: '未定',
      sources: [entry],
    });
    expect(ok.success).toBe(true);
    const dup = sourceRegistrySchema.safeParse({
      version: '1',
      reviewed_by: '未定',
      sources: [entry, entry],
    });
    expect(dup.success).toBe(false);
  });

  it('rejects ids that signals could not reference', () => {
    expect(
      sourceRegistrySchema.safeParse({
        version: '1',
        reviewed_by: '未定',
        sources: [{ ...entry, id: 'Bad Id' }],
      }).success,
    ).toBe(false);
  });
});

describe('signal definitions', () => {
  it('flattens grouped examples and keeps the grouping', () => {
    const def = signal({});
    expect(def.examples_ja).toEqual(['なかまに いれてくれない', 'ハブられた', '既読スルーされる']);
    expect(def.examples_by_grade).toEqual(grouped);
    expect(() => validateSignalDefinition(def, known)).not.toThrow();
  });

  it('still parses the legacy flat list and legacy source, but validation asks for migration', () => {
    const legacy = signal({
      examples_ja: ['ハブられた'],
      evidence: { source: '各県いじめチェックリスト', strength: 'medium' },
    });
    expect(legacy.examples_ja).toEqual(['ハブられた']);
    expect(legacy.examples_by_grade).toBeUndefined();
    expect(() => validateSignalDefinition(legacy, known)).toThrow(/evidence\.sources: \[<id>\]/);
  });

  it('requires evidence to name at least one source', () => {
    expect(
      signalDefinitionSchema.safeParse({
        ...baseSignal,
        examples_ja: grouped,
        evidence: { strength: 'medium' },
      }).success,
    ).toBe(false);
  });

  it('rejects unknown source ids', () => {
    const def = signal({ evidence: { sources: ['nope'], strength: 'low' } });
    expect(() => validateSignalDefinition(def, known)).toThrow(/unknown source nope/);
  });

  it('requires an example for every declared grade band of an explicit model signal', () => {
    const missing = signal({ examples_ja: { low: ['x'], high: ['y'] } });
    expect(() => validateSignalDefinition(missing, known)).toThrow(/no example for grade band jhs/);
    const empty = signal({ examples_ja: { low: ['x'], high: ['y'], jhs: [] } });
    expect(() => validateSignalDefinition(empty, known)).toThrow(/no example for grade band jhs/);
    const flat = signal({ examples_ja: ['x', 'y', 'z'] });
    expect(() => validateSignalDefinition(flat, known)).toThrow(/grouped by grade band/);
  });

  it('rejects examples for an undeclared grade band', () => {
    const def = signal({ grade_bands: ['high', 'jhs'] });
    expect(() => validateSignalDefinition(def, known)).toThrow(/undeclared grade band low/);
  });

  it('does not demand examples from rule signals or non-explicit model signals', () => {
    const rule = signal({
      examples_ja: [],
      method: 'rule',
      metric: 'x_exam_flag',
      domain: 'x',
      explicit: false,
    });
    expect(() => validateSignalDefinition(rule, known)).not.toThrow();
    const soft = signal({ examples_ja: ['なんでもない'], explicit: false });
    expect(() => validateSignalDefinition(soft, known)).not.toThrow();
    const explicitRule = signal({ examples_ja: [], method: 'rule', domain: 'd' });
    expect(() => validateSignalDefinition(explicitRule, known)).not.toThrow();
  });

  it('defaults scoring to score and accepts observe', () => {
    expect(signal({}).scoring).toBe('score');
    expect(signal({ scoring: 'observe' }).scoring).toBe('observe');
  });
});

describe('lexicon', () => {
  const category = (id: string, expressions: string[], extra: Record<string, unknown> = {}) => ({
    id,
    label_ja: id,
    handling: 'x',
    explicit: false,
    grade_bands: ['low'],
    expressions,
    ...extra,
  });
  const lexicon = (categories: unknown[]): Lexicon =>
    lexiconSchema.parse({ language: 'ja', categories });

  it('normalizes with NFKC before comparing', () => {
    expect(normalizeExpression('ＯＤした ')).toBe('ODした');
    expect(normalizeExpression('ﾘｽｶ')).toBe('リスカ');
  });

  it('accepts distinct expressions across categories', () => {
    const ok = lexicon([category('a', ['別に', '普通']), category('crisis', ['死にたい'])]);
    expect(() => validateLexicon(ok)).not.toThrow();
  });

  it('fails on duplicates within and across categories, including width variants', () => {
    expect(() => validateLexicon(lexicon([category('a', ['別に', '別に'])]))).toThrow(
      /duplicate expression "別に" \(a\) already in a/,
    );
    expect(() =>
      validateLexicon(lexicon([category('a', ['ＯＤした']), category('crisis', ['ODした'])])),
    ).toThrow(/already in a/);
  });

  it('requires explicit and grade_bands on every category', () => {
    const noExplicit = lexicon([
      { id: 'a', label_ja: 'a', handling: 'x', grade_bands: ['low'], expressions: ['別に'] },
    ]);
    expect(() => validateLexicon(noExplicit)).toThrow(/lacks explicit/);
    const noBands = lexicon([
      { id: 'a', label_ja: 'a', handling: 'x', explicit: false, expressions: ['別に'] },
    ]);
    expect(() => validateLexicon(noBands)).toThrow(/lacks grade_bands/);
  });

  it('reports errors as KbIntegrityError with the lexicon path', () => {
    try {
      validateLexicon(lexicon([category('a', ['別に', '別に'])]));
    } catch (error) {
      expect(error).toBeInstanceOf(KbIntegrityError);
      expect((error as KbIntegrityError).path).toBe('lexicon/ja.yaml');
    }
  });
});

describe('hotlines', () => {
  const hotline = {
    id: 'sos_dial',
    name: 'SOS',
    phone: '0120-0-78310',
    audience: '子ども',
    official_url: 'https://www.mext.go.jp/',
    verified_at: null,
    verified_by: '未定',
  };

  it('requires official_url, verified_at and verified_by on every entry', () => {
    expect(hotlinesSchema.safeParse({ version: '1', resources: [hotline] }).success).toBe(true);
    for (const key of ['official_url', 'verified_at', 'verified_by'] as const) {
      const rest = Object.fromEntries(Object.entries(hotline).filter(([k]) => k !== key));
      expect(hotlinesSchema.safeParse({ version: '1', resources: [rest] }).success, key).toBe(
        false,
      );
    }
    expect(
      hotlinesSchema.safeParse({ version: '1', resources: [{ ...hotline, verified_at: 'soon' }] })
        .success,
    ).toBe(false);
  });

  it('lets unverified entries pass validation but rejects duplicates and empty contacts', () => {
    const parsed = hotlinesSchema.parse({
      version: '1',
      resources: [hotline],
      candidates: [{ ...hotline, id: 'other', verified_at: '2026-10-03' }],
    });
    expect(() => validateHotlines(parsed)).not.toThrow();
    expect(
      hotlinesSchema.safeParse({ version: '1', resources: [hotline], candidates: [hotline] })
        .success,
    ).toBe(false);
    const contactless = Object.fromEntries(Object.entries(hotline).filter(([k]) => k !== 'phone'));
    expect(() =>
      validateHotlines(hotlinesSchema.parse({ version: '1', resources: [contactless] })),
    ).toThrow(/needs a phone or a url/);
  });
});

describe('school calendars', () => {
  const calendar = {
    id: 'tokyo_2026',
    prefecture: '東京都',
    city: null,
    school_level: 'both',
    year: 2026,
    terms: [{ name: '1学期', start: '2026-04-06', end: '2026-07-20' }],
    long_breaks: [{ name: '夏休み', start: '2026-07-21', end: '2026-08-25' }],
    source_ids: ['doc_prd'],
    verified: false,
    verified_at: null,
    verified_by: '未定',
    notes: '',
  };

  it('accepts placeholders and rejects inverted spans', () => {
    const file = { version: '1', reviewed_by: '未定', calendars: [calendar] };
    expect(schoolCalendarsSchema.safeParse(file).success).toBe(true);
    const inverted = {
      ...file,
      calendars: [
        { ...calendar, terms: [{ name: '1学期', start: '2026-07-20', end: '2026-04-06' }] },
      ],
    };
    expect(schoolCalendarsSchema.safeParse(inverted).success).toBe(false);
  });
});
