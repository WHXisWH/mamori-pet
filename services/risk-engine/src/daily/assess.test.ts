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
import { loadSignalDefs, scoringOf, type Scoring } from '../scoring.js';
import { aggregateDay } from './features.js';

const KB_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../../kb/v0.1.0');
const D = '2026-11-20';

let rules: RiskRules;
let defs: FeatureDefinition[];
let holidays: Set<string>;
let scoring: Scoring;
let scoredDefs: FeatureDefinition[];

beforeAll(async () => {
  const kb = await Kb.load(new FsKbSource(KB_DIR));
  scoring = scoringOf(await loadSignalDefs(kb));
  rules = await kb.yaml('rules/risk_rules.yaml', riskRulesSchema);
  defs = (await kb.yaml('rules/features.yaml', featuresSchema)).features;
  holidays = new Set(
    (await kb.yaml('resources/jp_holidays.yaml', holidaysSchema)).holidays.map((h) => h.date),
  );
  scoredDefs = defs.filter(scoring.scored);
});

// 各領域に代表の特徴を1つ：ふだんの値には少しゆらぎを持たせ、逸脱時は明らかに悪化した値にする
const NORMAL: Record<string, (i: number) => number> = {
  a_valence_mean: (i) => 0.4 + (i % 5) * 0.05,
  i_message_count: (i) => 10 + (i % 5),
  k_delete_ratio_mean: (i) => 0.08 + (i % 3) * 0.01,
  v_speech_rate_mean: (i) => 4 + (i % 4) * 0.1,
  d_isolated_mean: (i) => (i % 4) * 0.1,
};
const BAD: Record<string, number> = {
  a_valence_mean: -0.6,
  i_message_count: 1,
  k_delete_ratio_mean: 0.6,
  v_speech_rate_mean: 1.5,
  d_isolated_mean: 1,
};
const FEATURE_OF: Partial<Record<Domain, string>> = {
  a: 'a_valence_mean',
  i: 'i_message_count',
  k: 'k_delete_ratio_mean',
  v: 'v_speech_rate_mean',
  d: 'd_isolated_mean',
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
    for (const [name, f] of Object.entries(NORMAL)) {
      // D は使うケースにだけ登場させ、プロパティテストの履歴は元の規模のままにする
      if (name.startsWith('d_') && spec.deviate?.d === undefined) continue;
      day.set(name, f(i));
    }
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

  it('keeps observe signals out of scored features but still records observe features', () => {
    expect(scoring.scored(defs.find((f) => f.name === 'a_concern_sum')!)).toBe(true);
    expect(scoring.scored(defs.find((f) => f.name === 'd_self_size_mean')!)).toBe(false);
    expect(scoring.scored(defs.find((f) => f.name === 'd_story_negative_mean')!)).toBe(false);
    const out = aggregateDay(
      [
        { domain: 'a', value: 0.8, signalDefId: 'A-TEASE-001' },
        // 書き込み時に observe と記された古いシグナルも、kb 側で observe に変わったシグナルも、スコア対象の特徴には数えない
        { domain: 'a', value: 0.9, signalDefId: 'A-TEASE-001', scoring: 'observe' },
        {
          domain: 'd',
          value: 1,
          signalDefId: 'D-SELF-001',
          metric: { name: 'd_self_size_ratio', value: 0.1 },
        },
      ],
      defs,
      scoring,
    );
    const by = Object.fromEntries(out.map((f) => [f.name, f.value]));
    expect(by['a_concern_sum']).toBeCloseTo(0.8);
    expect(by['d_self_size_mean']).toBeCloseTo(0.1);
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
      // 重みの低い領域は 0.5 として数える：1 + 0.5 では L2 に必要な 2 領域に届かない
      name: 'low-weight domain with another counts as half',
      spec: { deviate: { k: 7, a: 7 } },
      level: 'l1',
      domains: ['a', 'k'],
    },
    {
      name: 'two full domains plus a low-weight one',
      spec: { deviate: { a: 7, i: 7, k: 7 } },
      level: 'l2',
      domains: ['a', 'k', 'i'],
    },
    {
      name: 'D and K together never trigger a level',
      spec: { deviate: { d: 10, k: 10 } },
      level: 'l0',
      domains: [],
    },
    {
      name: 'A and D for 7 days: 1.5 domains',
      spec: { deviate: { a: 7, d: 7 } },
      level: 'l1',
      domains: ['a', 'd'],
    },
    {
      name: 'low-weight domains do not count toward L3 today',
      spec: { deviate: { a: 1, i: 1, k: 1 } },
      level: 'l0',
      domains: [],
    },
    {
      name: 'cold start: three domains today is not L3',
      spec: { deviate: { a: 1, i: 1, v: 1 } },
      over: { inColdStart: true },
      level: 'l0',
      domains: [],
    },
    {
      name: 'cold start, first day: one artwork and two signals',
      spec: { deviate: { d: 1, a: 1, i: 1 } },
      over: { inColdStart: true },
      level: 'l0',
      domains: [],
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

  it('observe-only features cannot move the level, however far they deviate', () => {
    expect(scoredDefs.some((f) => f.domain === 'd')).toBe(false);
    const spec: Spec = {
      deviate: { a: 7, d: 14, k: 7 },
      extra: (date, day) => {
        day.set('d_self_size_mean', date > addDays(D, -14) ? 0.01 : 0.4);
        day.set('d_story_negative_mean', date > addDays(D, -14) ? 1 : 0);
      },
    };
    // フィルタなしなら A 1 + D 0.5 + K 0.5 = 2 → L2。observe を読まなくなると A + K = 1.5 だけ残り → L1
    expect(run(spec).level).toBe('l2');
    const out = run(spec, { features: scoredDefs });
    expect({ level: out.level, domains: out.domainsFlagged }).toEqual({
      level: 'l1',
      domains: ['a', 'k'],
    });
  });

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

  // 01-prd モジュール1「リスクレベル分類」：コールドスタート中はベースラインを学ぶだけで、L1・L2 を出さず、当日の複数領域を理由に L3 にもしない
  it('cold start never raises any level from features alone, whatever the history', () => {
    const r = rng(4);
    let raisedOutside = 0;
    for (let n = 0; n < 300; n++) {
      const deviate: Partial<Record<Domain, number>> = {};
      for (const d of ['a', 'i', 'k', 'v', 'd'] as Domain[])
        if (r() < 0.7) deviate[d] = Math.floor(r() * 21);
      expect(run({ deviate }, { inColdStart: true }).level).toBe('l0');
      if (run({ deviate }).level !== 'l0') raisedOutside++;
    }
    // 対照：同じ履歴でもコールドスタートを抜けたあとはかなりの割合でレベルが上がる。そうでなければ上の確認に意味がない
    expect(raisedOutside).toBeGreaterThan(100);
  });

  // D と K は重みの低い領域：これらだけが外れているときは、どれだけ続いても単独ではどのレベルにもならない
  it('low-weight domains alone never trigger a level, however long they persist', () => {
    const r = rng(5);
    for (let n = 0; n < 300; n++) {
      const deviate: Partial<Record<Domain, number>> = {
        d: Math.floor(r() * 22),
        k: Math.floor(r() * 22),
      };
      const missing = Array.from({ length: Math.floor(r() * 3) }, () =>
        addDays(D, -Math.floor(r() * 14)),
      );
      expect(run({ deviate, missing }).level).toBe('l0');
      // 対照：重みが満点の領域を1つ加えて 7 日続けると、D/K も続いていればレベルが上がる
      if ((deviate.d ?? 0) >= 7 || (deviate.k ?? 0) >= 7)
        expect(run({ deviate: { ...deviate, a: 7 }, missing: [] }).level).not.toBe('l0');
    }
  });

  // 子どもが被害をはっきり話したとき：履歴にもコールドスタートかどうかにも関係なく L3 にする（コールドスタートの制限を受けない）
  it('an explicit statement is always L3, in or out of cold start', () => {
    const r = rng(6);
    for (let n = 0; n < 200; n++) {
      const history = randomHistory(r);
      const explicitDomains = r() < 0.5 ? (['a'] as Domain[]) : (['a', 'd'] as Domain[]);
      const out = run({}, { history, inColdStart: r() < 0.5, explicitDomains });
      expect(out.level).toBe('l3');
      expect(out.explanation.explicit).toBe(true);
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
