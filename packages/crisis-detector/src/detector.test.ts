import { describe, expect, it, vi } from 'vitest';

import {
  CrisisDetector,
  isPaused,
  ModelBreaker,
  ModelCallError,
  type CrisisInput,
  type ModelEvent,
  type CrisisReviewer,
  type ReviewResult,
  type SemanticScreener,
} from './detector.js';
import { KeywordMatcher } from './keyword.js';

const keywords = new KeywordMatcher(['死にたい', '消えたい']);

const input = (text: string): CrisisInput => ({ text, gradeBand: 'high', priorTurns: [] });

const hitResult: ReviewResult = {
  hit: true,
  category: 'self_harm',
  confidence: 0.9,
  evidenceSpan: '死にたい',
};
const missResult: ReviewResult = {
  hit: false,
  category: 'none',
  confidence: 0.1,
};

function screener(suspect: boolean, delayMs = 0): SemanticScreener {
  return {
    screen: vi.fn<SemanticScreener['screen']>(
      (_i, signal) =>
        new Promise((resolve, reject) => {
          const t = setTimeout(() => resolve({ suspect }), delayMs);
          signal.addEventListener('abort', () => {
            clearTimeout(t);
            reject(new Error('aborted'));
          });
        }),
    ),
  };
}

function reviewer(result: ReviewResult | Error, delayMs = 0): CrisisReviewer {
  return {
    review: vi.fn<CrisisReviewer['review']>(
      (_i, signal) =>
        new Promise((resolve, reject) => {
          const t = setTimeout(
            () => (result instanceof Error ? reject(result) : resolve(result)),
            delayMs,
          );
          signal.addEventListener('abort', () => {
            clearTimeout(t);
            reject(new Error('aborted'));
          });
        }),
    ),
  };
}

const fast = { screenTimeoutMs: 50, reviewTimeoutMs: 50 };

describe('CrisisDetector', () => {
  it('keyword hit confirmed by review → hit via review', async () => {
    const s = screener(false);
    const d = new CrisisDetector(keywords, s, reviewer(hitResult), fast);
    const r = await d.check(input('もう死にたい'));
    expect(r).toMatchObject({
      hit: true,
      category: 'self_harm',
      method: 'review',
      keywordMatched: true,
      evidenceSpan: '死にたい',
    });
    expect(s.screen).not.toHaveBeenCalled();
  });

  it('keyword hit rejected by review (idiom) → no hit, still records keyword match', async () => {
    const d = new CrisisDetector(
      new KeywordMatcher(['死ぬ']),
      screener(false),
      reviewer(missResult),
      fast,
    );
    const r = await d.check(input('死ぬほど笑った'));
    expect(r.hit).toBe(false);
    expect(r.keywordMatched).toBe(true);
    expect(r.category).toBe('none');
    expect(r.evidenceSpan).toBeUndefined();
  });

  it('review timeout after a keyword hit is a hit with category other (guardian is notified)', async () => {
    const d = new CrisisDetector(keywords, screener(false), reviewer(hitResult, 500), fast);
    const r = await d.check(input('消えたい'));
    expect(r.hit).toBe(true);
    expect(r.method).toBe('review_timeout');
    expect(r.category).toBe('other');
    expect(r.familyHarmSuspected).toBe(false);
    expect(r.availability).toBe('unavailable');
  });

  it('review error after a keyword hit is still a hit with category other', async () => {
    const d = new CrisisDetector(keywords, screener(false), reviewer(new Error('boom')), fast);
    const r = await d.check(input('消えたい'));
    expect(r).toMatchObject({ hit: true, method: 'review_timeout', category: 'other' });
  });

  it('no keyword, screener not suspicious → no hit, review not called', async () => {
    const rv = reviewer(hitResult);
    const d = new CrisisDetector(keywords, screener(false), rv, fast);
    const r = await d.check(input('きょうは たのしかった'));
    expect(r).toMatchObject({ hit: false, method: 'none', keywordMatched: false });
    expect(rv.review).not.toHaveBeenCalled();
  });

  it('no keyword, screener suspicious, review confirms → hit', async () => {
    const d = new CrisisDetector(
      keywords,
      screener(true),
      reviewer({ ...hitResult, category: 'violence' }),
      fast,
    );
    const r = await d.check(input('毎日なぐられてる'));
    expect(r).toMatchObject({
      hit: true,
      category: 'violence',
      method: 'review',
      keywordMatched: false,
    });
  });

  it('no keyword, screener suspicious, review rejects → no hit via screen', async () => {
    const d = new CrisisDetector(keywords, screener(true), reviewer(missResult), fast);
    const r = await d.check(input('ゲームで死んだ'));
    expect(r.hit).toBe(false);
    expect(r.method).toBe('screen');
  });

  it('screener timeout requires review instead of claiming clear', async () => {
    const rv = reviewer(hitResult);
    const d = new CrisisDetector(keywords, screener(true, 500), rv, fast);
    const r = await d.check(input('なんでもない'));
    expect(r.hit).toBe(true);
    expect(rv.review).toHaveBeenCalled();
  });

  it('screener error requires review', async () => {
    const s: SemanticScreener = {
      screen: vi.fn(async () => {
        throw new Error('boom');
      }),
    };
    const d = new CrisisDetector(keywords, s, reviewer(hitResult), fast);
    expect((await d.check(input('なんでもない'))).hit).toBe(true);
  });

  it('no keyword and review unavailable → paused, neither released nor a crisis', async () => {
    for (const rv of [reviewer(new Error('boom')), reviewer(hitResult, 500)]) {
      const d = new CrisisDetector(keywords, screener(true), rv, fast);
      const r = await d.check(input('なんでもない'));
      expect(r).toMatchObject({
        hit: false,
        method: 'paused',
        availability: 'unavailable',
        category: 'none',
        familyHarmSuspected: false,
      });
      expect(isPaused(r)).toBe(true);
    }
  });

  it('no keyword, screener and review both unavailable → paused', async () => {
    const s: SemanticScreener = { screen: vi.fn(async () => Promise.reject(new Error('x'))) };
    const d = new CrisisDetector(keywords, s, reviewer(new Error('boom')), fast);
    expect(isPaused(await d.check(input('なんでもない')))).toBe(true);
  });

  it.each(['self_harm', 'violence', 'extortion', 'family_harm', 'other'] as const)(
    'derives familyHarmSuspected from category %s',
    async (category) => {
      const d = new CrisisDetector(
        keywords,
        screener(false),
        reviewer({ ...hitResult, category }),
        fast,
      );
      const r = await d.check(input('死にたい'));
      expect(r).toMatchObject({ hit: true, category });
      expect(r.familyHarmSuspected).toBe(category === 'family_harm');
    },
  );

  it('maps a hit without a category to other and a miss to none', async () => {
    const d = new CrisisDetector(
      keywords,
      screener(false),
      reviewer({ ...hitResult, category: 'none' }),
      fast,
    );
    expect(await d.check(input('死にたい'))).toMatchObject({
      category: 'other',
      familyHarmSuspected: false,
    });
    const d2 = new CrisisDetector(
      keywords,
      screener(false),
      reviewer({ ...missResult, category: 'family_harm' }),
      fast,
    );
    expect(await d2.check(input('死にたい'))).toMatchObject({
      category: 'none',
      familyHarmSuspected: false,
    });
  });

  it('exposes a synchronous keyword-only check and measures latency', async () => {
    let t = 0;
    const d = new CrisisDetector(keywords, screener(false), reviewer(hitResult), {
      ...fast,
      now: () => (t += 5),
    });
    expect(d.keywordOnly('死にたい')).toBe(true);
    expect(d.keywordOnly('元気')).toBe(false);
    expect((await d.check(input('元気'))).latencyMs).toBe(5);
  });

  it('retries a quota error exactly once after a jittered backoff', async () => {
    const events: ModelEvent['kind'][] = [];
    const review = vi
      .fn<CrisisReviewer['review']>()
      .mockRejectedValueOnce(new ModelCallError('quota'))
      .mockResolvedValueOnce(hitResult);
    const d = new CrisisDetector(
      keywords,
      screener(false),
      { review },
      {
        reviewTimeoutMs: 2000,
        random: () => 0,
        onModelEvent: (e) => events.push(e.kind),
      },
    );
    const r = await d.check(input('死にたい'));
    expect(r).toMatchObject({ hit: true, method: 'review', category: 'self_harm' });
    expect(review).toHaveBeenCalledTimes(2);
    expect(events).toEqual(['quota', 'retry']);

    const always = vi.fn<CrisisReviewer['review']>(async () => {
      throw new ModelCallError('quota');
    });
    const d2 = new CrisisDetector(
      keywords,
      screener(true),
      { review: always },
      {
        reviewTimeoutMs: 2000,
        random: () => 0,
      },
    );
    expect(isPaused(await d2.check(input('なんでもない')))).toBe(true);
    expect(always).toHaveBeenCalledTimes(2);
  });

  it('does not retry timeouts or ordinary errors', async () => {
    const review = vi.fn<CrisisReviewer['review']>(async () => {
      throw new ModelCallError('error');
    });
    const d = new CrisisDetector(keywords, screener(true), { review }, fast);
    expect(isPaused(await d.check(input('なんでもない')))).toBe(true);
    expect(review).toHaveBeenCalledTimes(1);
  });

  it('reports a timeout without the input text', async () => {
    const events: ModelEvent[] = [];
    const d = new CrisisDetector(keywords, screener(true, 500), reviewer(hitResult, 500), {
      ...fast,
      onModelEvent: (e) => events.push(e),
    });
    await d.check(input('なんでもない'));
    expect(events).toEqual([
      { layer: 'screen', kind: 'timeout' },
      { layer: 'review', kind: 'timeout' },
    ]);
  });

  it('uses config defaults when no options are given', () => {
    expect(() => new CrisisDetector(keywords, screener(false), reviewer(hitResult))).not.toThrow();
  });
});

describe('ModelBreaker', () => {
  it('opens after N consecutive quota errors within the window and recovers after openMs', () => {
    let t = 0;
    const b = new ModelBreaker(() => t, { windowMs: 60_000, threshold: 3, openMs: 30_000 });
    expect(b.quotaFailure()).toBe(false);
    t = 1000;
    expect(b.quotaFailure()).toBe(false);
    t = 2000;
    expect(b.quotaFailure()).toBe(true);
    expect(b.isOpen).toBe(true);
    t = 31_999;
    expect(b.isOpen).toBe(true);
    t = 32_000;
    expect(b.isOpen).toBe(false);
  });

  it('a success or an expired window resets the count', () => {
    let t = 0;
    const b = new ModelBreaker(() => t, { windowMs: 60_000, threshold: 2, openMs: 30_000 });
    b.quotaFailure();
    b.success();
    expect(b.quotaFailure()).toBe(false);
    t = 61_000;
    expect(b.quotaFailure()).toBe(false);
    expect(b.isOpen).toBe(false);
  });

  it('while open the detector skips models: keyword hits stay crises, others pause', async () => {
    let t = 0;
    const breaker = new ModelBreaker(() => t, { windowMs: 60_000, threshold: 1, openMs: 30_000 });
    const events: ModelEvent['kind'][] = [];
    const review = vi.fn<CrisisReviewer['review']>(async () => {
      throw new ModelCallError('quota');
    });
    const s = screener(true);
    const d = new CrisisDetector(
      keywords,
      s,
      { review },
      {
        ...fast,
        breaker,
        now: () => t,
        onModelEvent: (e) => events.push(e.kind),
      },
    );
    expect(isPaused(await d.check(input('なんでもない')))).toBe(true);
    expect(events).toContain('breaker_open');
    expect(d.modelUnavailable).toBe(true);
    review.mockClear();
    vi.mocked(s.screen).mockClear();

    expect(isPaused(await d.check(input('ふつうの話')))).toBe(true);
    expect(await d.check(input('死にたい'))).toMatchObject({
      hit: true,
      category: 'other',
      method: 'review_timeout',
      availability: 'unavailable',
    });
    expect(review).not.toHaveBeenCalled();
    expect(s.screen).not.toHaveBeenCalled();

    t = 30_000;
    expect(d.modelUnavailable).toBe(false);
    review.mockResolvedValueOnce(missResult);
    await d.check(input('死にたい'));
    expect(review).toHaveBeenCalledTimes(1);
  });
});
