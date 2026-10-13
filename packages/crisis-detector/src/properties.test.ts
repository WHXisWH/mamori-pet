import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CrisisCategory } from '@ijime/api-types';
import { FsKbSource, Kb, lexiconSchema } from '@ijime/kb-loader';
import fc from 'fast-check';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  CrisisDetector,
  ModelBreaker,
  ModelCallError,
  MODEL_FAILURE_REASONS,
  type CrisisReviewer,
  type ModelEvent,
  type ReviewResult,
  type SemanticScreener,
} from './detector.js';
import { CRISIS_CATEGORY_ID, KeywordMatcher } from './keyword.js';

// プロパティテスト：例を並べるテストでは思いついた書き方しか確かめられない。ここでは「あらゆる入力」について危機検知の安全上の不変条件を確かめる

const KB_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../kb/v0.1.0');

let expressions: string[];
let matcher: KeywordMatcher;
beforeAll(async () => {
  const kb = await Kb.load(new FsKbSource(KB_DIR));
  const lexicon = await kb.yaml('lexicon/ja.yaml', lexiconSchema);
  expressions = lexicon.categories.find((c) => c.id === CRISIS_CATEGORY_ID)!.expressions;
  matcher = KeywordMatcher.fromLexicon(lexicon);
});

// 子どもが入力しそうな文字：かな、よく使う漢字、英数字、絵文字、句読点と空白
const CONTEXT_CHARS = [
  ...'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん',
  ...'アイウエオカキクケコサシスセソタチツテトナニヌネノ',
  ...'今日学校友達先生家帰る行く本当',
  ...'abcxyzABC0123',
  ...['😢', '😭', '🙂', '💦', ' ', '　', '。', '、', '！', '？', '…', 'w', '\n'],
];
const context = fc.string({ unit: fc.constantFrom(...CONTEXT_CHARS), maxLength: 12 });

// docs/02「危機検知器」：正規化は「ひらがなとカタカナをそろえ、全角と半角をそろえ、空白と繰り返し文字を取り除く」
const SEPARATORS = [' ', '　', 'ー', '・', '…', '、', '。', '〜', '!', '！', '?', '？'];

function toKatakana(s: string): string {
  return [...s]
    .map((ch) => {
      const code = ch.codePointAt(0)!;
      return code >= 0x3041 && code <= 0x3096 ? String.fromCodePoint(code + 0x60) : ch;
    })
    .join('');
}

function toFullwidthAscii(s: string): string {
  return [...s]
    .map((ch) => {
      const code = ch.codePointAt(0)!;
      return code >= 0x21 && code <= 0x7e ? String.fromCodePoint(code + 0xfee0) : ch;
    })
    .join('');
}

type Variant = {
  katakana: boolean;
  fullwidth: boolean;
  lowercase: boolean;
  separators: (string | null)[];
  trailingRepeat: number;
};

const variant = fc.record({
  katakana: fc.boolean(),
  fullwidth: fc.boolean(),
  lowercase: fc.boolean(),
  separators: fc.array(fc.option(fc.constantFrom(...SEPARATORS), { nil: null }), {
    maxLength: 16,
  }),
  trailingRepeat: fc.integer({ min: 0, max: 5 }),
});

function applyVariant(expr: string, v: Variant): string {
  let s = expr;
  if (v.katakana) s = toKatakana(s);
  if (v.lowercase) s = s.toLowerCase();
  if (v.fullwidth) s = toFullwidthAscii(s);
  const chars = [...s];
  const spaced = chars.map((ch, i) => (i < chars.length - 1 ? ch + (v.separators[i] ?? '') : ch));
  return spaced.join('') + chars[chars.length - 1]!.repeat(v.trailingRepeat);
}

describe('keyword layer properties (real kb lexicon)', () => {
  it('any crisis expression is caught whatever surrounds it', () => {
    fc.assert(
      fc.property(fc.nat(), context, context, (pick, before, after) => {
        const expr = expressions[pick % expressions.length]!;
        expect(matcher.match(before + expr + after).hit).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it('any crisis expression is caught across kana, width, case, spacing and elongation', () => {
    fc.assert(
      fc.property(fc.nat(), variant, context, context, (pick, v, before, after) => {
        const expr = expressions[pick % expressions.length]!;
        expect(matcher.match(before + applyVariant(expr, v) + after).hit).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });

  it('does not depend on earlier calls', () => {
    fc.assert(
      fc.property(fc.array(context, { maxLength: 5 }), fc.nat(), (noise, pick) => {
        const expr = expressions[pick % expressions.length]!;
        for (const n of noise) matcher.match(n);
        expect(matcher.match(expr).hit).toBe(true);
      }),
    );
  });
});

// モデル層の呼び出しは毎回、結果を返すか、さまざまなエラーを投げるか、制限時間で中止されるまで返らないかのどれかになりうる
type Outcome<T> = { kind: 'ok'; value: T } | { kind: 'throw'; error: Error } | { kind: 'hang' };

const CATEGORIES: CrisisCategory[] = [
  'none',
  'self_harm',
  'violence',
  'extortion',
  'family_harm',
  'other',
];

const modelError: fc.Arbitrary<Error> = fc.oneof(
  fc
    .tuple(
      fc.constantFrom('quota', 'timeout', 'error' as const),
      fc.option(fc.constantFrom(...MODEL_FAILURE_REASONS), { nil: undefined }),
    )
    .map(([kind, reason]) => new ModelCallError(kind, reason)),
  fc.constant(new Error('network')),
  fc.constant(new SyntaxError('Unexpected token')),
);

function outcome<T>(value: fc.Arbitrary<T>): fc.Arbitrary<Outcome<T>> {
  return fc.oneof(
    value.map((v) => ({ kind: 'ok' as const, value: v })),
    modelError.map((error) => ({ kind: 'throw' as const, error })),
    fc.constant({ kind: 'hang' as const }),
  );
}

const reviewValue: fc.Arbitrary<ReviewResult> = fc.record({
  hit: fc.boolean(),
  category: fc.constantFrom(...CATEGORIES),
  confidence: fc.double({ min: 0, max: 1, noNaN: true }),
});

function play<T>(o: Outcome<T>, signal: AbortSignal): Promise<T> {
  if (o.kind === 'ok') return Promise.resolve(o.value);
  if (o.kind === 'throw') return Promise.reject(o.error);
  return new Promise((_resolve, reject) =>
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
  );
}

const CANARY = 'CANARY-しにたい-7f3a';

function detectorFor(screen: Outcome<{ suspect: boolean }>, review: Outcome<ReviewResult>) {
  const calls = { screen: 0, review: 0 };
  const events: ModelEvent[] = [];
  const screener: SemanticScreener = {
    screen: (_i, signal) => {
      calls.screen += 1;
      return play(screen, signal);
    },
  };
  const reviewer: CrisisReviewer = {
    review: (_i, signal) => {
      calls.review += 1;
      return play(review, signal);
    },
  };
  // サーキットブレーカーのしきい値を大きくする。実行ごとに独立した検知器を使い、前の実行のクォータエラーが次の実行に影響しないようにする
  const breaker = new ModelBreaker(() => performance.now(), {
    windowMs: 60_000,
    threshold: 1_000,
    openMs: 1,
  });
  const detector = new CrisisDetector(new KeywordMatcher([CANARY]), screener, reviewer, {
    screenTimeoutMs: 15,
    reviewTimeoutMs: 15,
    breaker,
    random: () => 0,
    onModelEvent: (e) => events.push(e),
  });
  return { detector, calls, events };
}

const screenOutcome = outcome(fc.record({ suspect: fc.boolean() }));
const reviewOutcome = outcome(reviewValue);
const input = (text: string) => ({ text, gradeBand: 'high' as const, priorTurns: [] });

describe('detector fail-safe properties (decided 2026-10-03)', () => {
  it('a keyword hit is a crisis unless the review explicitly clears it', async () => {
    await fc.assert(
      fc.asyncProperty(screenOutcome, reviewOutcome, async (screen, review) => {
        const { detector, calls } = detectorFor(screen, review);
        const r = await detector.check(input(`もう${CANARY}よ`));
        expect(calls.screen).toBe(0);
        expect(r.keywordMatched).toBe(true);
        if (review.kind === 'ok') {
          expect(r.hit).toBe(review.value.hit);
          expect(r.method).toBe('review');
        } else {
          expect(r).toMatchObject({
            hit: true,
            category: 'other',
            familyHarmSuspected: false,
            method: 'review_timeout',
            availability: 'unavailable',
          });
        }
      }),
      { numRuns: 150 },
    );
  });

  it('without a keyword, input passes only after a model actually cleared it; otherwise it pauses', async () => {
    await fc.assert(
      fc.asyncProperty(screenOutcome, reviewOutcome, async (screen, review) => {
        const { detector, calls } = detectorFor(screen, review);
        const r = await detector.check(input('きょうは学校でいろいろあった'));
        const screenCleared = screen.kind === 'ok' && !screen.value.suspect;
        if (screenCleared) {
          expect(r).toMatchObject({ hit: false, method: 'none', availability: 'verified' });
          expect(calls.review).toBe(0);
        } else if (review.kind === 'ok') {
          expect(r.hit).toBe(review.value.hit);
          expect(r.method).toBe(review.value.hit ? 'review' : 'screen');
          expect(r.availability).toBe('verified');
        } else {
          expect(r).toMatchObject({ hit: false, method: 'paused', availability: 'unavailable' });
        }
      }),
      { numRuns: 150 },
    );
  });

  it('every result is internally consistent and model events never carry input text', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        screenOutcome,
        reviewOutcome,
        async (withKeyword, screen, review) => {
          const { detector, events } = detectorFor(screen, review);
          const text = withKeyword ? CANARY : 'CANARY-ふつうの話-7f3a';
          const r = await detector.check(input(text));
          expect(r.hit).toBe(r.category !== 'none');
          expect(r.familyHarmSuspected).toBe(r.category === 'family_harm');
          if (r.method === 'paused') expect(r.hit).toBe(false);
          if (r.method === 'none') expect(r.availability).toBe('verified');
          expect(JSON.stringify(events)).not.toContain('CANARY');
          expect(JSON.stringify({ ...r, evidenceSpan: undefined })).not.toContain('CANARY');
        },
      ),
      { numRuns: 150 },
    );
  });
});
