import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Domain } from '@ijime/api-types';
import {
  featuresSchema,
  FsKbSource,
  holidaysSchema,
  Kb,
  riskRulesSchema,
  type FeatureDefinition,
  type RiskRules,
} from '@ijime/kb-loader';
import { beforeAll, describe, expect, it } from 'vitest';

import { RISK_LEVELS } from '@ijime/api-types';

import { assess, type AssessInput, type History } from './assess.js';
import { addDays, dayType, type ContextSpan } from './calendar.js';
import { aggregateDay } from './features.js';

const KB_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../../kb/v0.1.0');
const D = '2026-11-20';

let rules: RiskRules;
let defs: FeatureDefinition[];
let holidays: Set<string>;

beforeAll(async () => {
  const kb = await Kb.load(new FsKbSource(KB_DIR));
  rules = await kb.yaml('rules/risk_rules.yaml', riskRulesSchema);
  defs = (await kb.yaml('rules/features.yaml', featuresSchema)).features;
  holidays = new Set(
    (await kb.yaml('resources/jp_holidays.yaml', holidaysSchema)).holidays.map((h) => h.date),
  );
});

// 各領域に代表の特徴を1つ：ふだんの値には少しゆらぎを持たせ、逸脱時は明らかに悪化した値にする
const NORMAL: Record<string, (i: number) => number> = {
  a_valence_mean: (i) => 0.4 + (i % 5) * 0.05,
  i_message_count: (i) => 10 + (i % 5),
  k_delete_ratio_mean: (i) => 0.08 + (i % 3) * 0.01,
  v_speech_rate_mean: (i) => 4 + (i % 4) * 0.1,
};
const BAD: Record<string, number> = {
  a_valence_mean: -0.6,
  i_message_count: 1,
  k_delete_ratio_mean: 0.6,
  v_speech_rate_mean: 1.5,
};
const FEATURE_OF: Partial<Record<Domain, string>> = {
  a: 'a_valence_mean',
  i: 'i_message_count',
  k: 'k_delete_ratio_mean',
  v: 'v_speech_rate_mean',
};

type Spec = {
  // 直近何日間（当日を含む）、各領域が逸脱しているか
  deviate?: Partial<Record<Domain, number>>;
  // これらの日付は1日分まるごとデータがない
  missing?: string[];
  extra?: (date: string, day: Map<string, number>) => void;
};

function build(spec: Spec): Map<string, Map<string, number>> {
  const h = new Map<string, Map<string, number>>();
  for (let i = 60; i >= 0; i--) {
    const date = addDays(D, -i);
    if (spec.missing?.includes(date)) continue;
    const day = new Map<string, number>();
    for (const [name, f] of Object.entries(NORMAL)) day.set(name, f(i));
    for (const [domain, n] of Object.entries(spec.deviate ?? {})) {
      if (i < n!) day.set(FEATURE_OF[domain as Domain]!, BAD[FEATURE_OF[domain as Domain]!]!);
    }
    spec.extra?.(date, day);
    h.set(date, day);
  }
  return h;
}

function run(spec: Spec, over: Partial<AssessInput> = {}) {
  return assess({
    date: D,
    history: build(spec),
    contexts: [],
    holidays,
    features: defs,
    rules,
    inColdStart: false,
    explicitDomains: [],
    ...over,
  });
}

describe('calendar', () => {
  it('weekends, holidays and long vacations are rest days', () => {
    expect(dayType('2026-11-20', holidays, [], ['long_vacation'])).toBe('school');
    expect(dayType('2026-11-21', holidays, [], ['long_vacation'])).toBe('rest');
    expect(dayType('2026-11-23', holidays, [], ['long_vacation'])).toBe('rest');
    const summer: ContextSpan = {
      category: 'long_vacation',
      startDate: '2026-07-21',
      endDate: '2026-08-31',
    };
    expect(dayType('2026-08-03', holidays, [summer], ['long_vacation'])).toBe('rest');
  });
});

describe('aggregateDay', () => {
  it('follows features.yaml and leaves inactive days empty', () => {
    const out = aggregateDay(
      [
        { domain: 'a', value: 1, metric: { name: 'a_valence', value: -0.5 } },
        { domain: 'a', value: 1, metric: { name: 'a_valence', value: 0.1 } },
        { domain: 'i', value: 1, metric: { name: 'i_message_hour', value: 23 } },
        { domain: 'i', value: 1, metric: { name: 'i_message_hour', value: 15 } },
        { domain: 'a', value: 0.8 },
      ],
      defs,
    );
    const by = Object.fromEntries(out.map((f) => [f.name, f.value]));
    expect(by['a_valence_mean']).toBeCloseTo(-0.2);
    expect(by['a_concern_sum']).toBeCloseTo(0.8);
    expect(by['a_school_avoid_count']).toBe(0);
    expect(by['i_message_count']).toBe(2);
    expect(by['i_late_night_count']).toBe(1);
    expect(by['k_delete_ratio_mean']).toBeUndefined();
    expect(aggregateDay([], defs)).toEqual([]);
  });
});

describe('assess: level table', () => {
  const cases: {
    name: string;
    spec: Spec;
    over?: Partial<AssessInput>;
    level: string;
    domains: Domain[];
  }[] = [
    { name: 'steady history', spec: {}, level: 'l0', domains: [] },
    { name: 'one domain for 6 days', spec: { deviate: { a: 6 } }, level: 'l0', domains: [] },
    { name: 'one domain for 7 days', spec: { deviate: { a: 7 } }, level: 'l1', domains: ['a'] },
    { name: 'two domains for 6 days', spec: { deviate: { a: 6, i: 6 } }, level: 'l0', domains: [] },
    {
      name: 'two domains for 7 days',
      spec: { deviate: { a: 7, i: 7 } },
      level: 'l2',
      domains: ['a', 'i'],
    },
    {
      name: 'a long streak is not absorbed into the baseline',
      spec: { deviate: { a: 20, i: 20 } },
      level: 'l2',
      domains: ['a', 'i'],
    },
    { name: 'low-weight domain alone', spec: { deviate: { k: 10 } }, level: 'l0', domains: [] },
    {
      name: 'low-weight domain with another',
      spec: { deviate: { k: 7, a: 7 } },
      level: 'l2',
      domains: ['a', 'k'],
    },
    {
      name: 'three domains today',
      spec: { deviate: { a: 1, i: 1, v: 1 } },
      level: 'l3',
      domains: ['a', 'v', 'i'],
    },
    {
      name: 'cold start holds back L2',
      spec: { deviate: { a: 7, i: 7 } },
      over: { inColdStart: true },
      level: 'l0',
      domains: [],
    },
    {
      name: 'explicit statement ignores cold start',
      spec: {},
      over: { inColdStart: true, explicitDomains: ['a'] },
      level: 'l3',
      domains: ['a'],
    },
    {
      name: 'exam halves a and keeps i',
      spec: { deviate: { a: 7, i: 7 } },
      over: { contexts: [{ category: 'exam', startDate: addDays(D, -10), endDate: D }] },
      level: 'l1',
      domains: ['i'],
    },
    {
      name: 'one missing day does not break the streak',
      spec: { deviate: { a: 8 }, missing: [addDays(D, -3)] },
      level: 'l1',
      domains: ['a'],
    },
    {
      name: 'three missing days break the streak',
      spec: { deviate: { a: 10 }, missing: [addDays(D, -3), addDays(D, -4), addDays(D, -5)] },
      level: 'l0',
      domains: [],
    },
    {
      name: 'school avoidance on 3 of 7 days',
      spec: {
        extra: (date, day) => {
          if ([D, addDays(D, -2), addDays(D, -5)].includes(date))
            day.set('a_school_avoid_count', 1);
        },
      },
      level: 'l2',
      domains: ['a'],
    },
    {
      name: 'school avoidance on 2 of 7 days',
      spec: {
        extra: (date, day) => {
          if ([D, addDays(D, -5)].includes(date)) day.set('a_school_avoid_count', 1);
        },
      },
      level: 'l0',
      domains: [],
    },
  ];
  for (const c of cases) {
    it(c.name, () => {
      const out = run(c.spec, c.over);
      expect({ level: out.level, domains: out.domainsFlagged }).toEqual({
        level: c.level,
        domains: c.domains,
      });
    });
  }

  it('explanation carries domains and whole days only', () => {
    const out = run({ deviate: { a: 9, i: 7 } });
    expect(out.explanation).toEqual({ domains: ['a', 'i'], days: 9 });
    expect(out.persistenceDays).toMatchObject({ a: 9, i: 7 });
    expect(out.baselines.find((b) => b.feature === 'a_valence_mean')).toMatchObject({
      dayType: 'school',
    });
  });
});

// 小さな決定論的乱数。失敗を再現できるようにする
function rng(seed: number) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

describe('assess: properties', () => {
  const rank = (l: string) => RISK_LEVELS.indexOf(l as never);

  function randomHistory(r: () => number): Map<string, Map<string, number>> {
    const deviate: Partial<Record<Domain, number>> = {};
    for (const d of ['a', 'i', 'k'] as Domain[]) if (r() < 0.6) deviate[d] = Math.floor(r() * 12);
    const missing = Array.from({ length: Math.floor(r() * 4) }, () =>
      addDays(D, -Math.floor(r() * 14)),
    );
    return build({ deviate, missing });
  }

  it('same input gives the same result', () => {
    const r = rng(1);
    for (let n = 0; n < 200; n++) {
      const history = randomHistory(r);
      const input = {
        date: D,
        history,
        contexts: [],
        holidays,
        features: defs,
        rules,
        inColdStart: false,
        explicitDomains: [],
      };
      expect(assess(input)).toEqual(assess(input));
    }
  });

  it('one more deviating domain never lowers the level', () => {
    const r = rng(2);
    for (let n = 0; n < 400; n++) {
      const history = randomHistory(r);
      const base = run({}, { history });
      const more = new Map([...history].map(([d, m]) => [d, new Map(m)]));
      for (let i = 0; i < 12; i++)
        more.get(addDays(D, -i))?.set('v_speech_rate_mean', BAD['v_speech_rate_mean']!);
      expect(rank(run({}, { history: more as History }).level)).toBeGreaterThanOrEqual(
        rank(base.level),
      );
    }
  });

  it('dropping a deviating value on the day never raises the level', () => {
    const r = rng(3);
    for (let n = 0; n < 400; n++) {
      const history = randomHistory(r);
      const base = run({}, { history });
      const less = new Map([...history].map(([d, m]) => [d, new Map(m)]));
      const today = less.get(D);
      if (!today) continue;
      for (const [name, bad] of Object.entries(BAD))
        if (today.get(name) === bad) today.delete(name);
      expect(rank(run({}, { history: less as History }).level)).toBeLessThanOrEqual(
        rank(base.level),
      );
    }
  });
});
