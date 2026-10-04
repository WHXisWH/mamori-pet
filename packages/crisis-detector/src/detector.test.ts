import { describe, expect, it, vi } from 'vitest';

import {
  CrisisDetector,
  type CrisisInput,
  type CrisisReviewer,
  type ReviewResult,
  type SemanticScreener,
} from './detector.js';
import { KeywordMatcher } from './keyword.js';

const keywords = new KeywordMatcher(['死にたい', '消えたい']);

const input = (text: string): CrisisInput => ({ text, gradeBand: 'high', priorTurns: [] });

const hitResult: ReviewResult = {
  hit: true,
  category: 'suicidal',
  familyHarmSuspected: false,
  confidence: 0.9,
  evidenceSpan: '死にたい',
};
const missResult: ReviewResult = {
  hit: false,
  category: 'none',
  familyHarmSuspected: false,
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
      category: 'suicidal',
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

  it('review timeout is treated as a hit', async () => {
    const d = new CrisisDetector(keywords, screener(false), reviewer(hitResult, 500), fast);
    const r = await d.check(input('消えたい'));
    expect(r.hit).toBe(true);
    expect(r.method).toBe('review_timeout');
    expect(r.familyHarmSuspected).toBe(true);
    expect(r.availability).toBe('unavailable');
  });

  it('review error is treated as a hit', async () => {
    const d = new CrisisDetector(keywords, screener(false), reviewer(new Error('boom')), fast);
    const r = await d.check(input('消えたい'));
    expect(r.hit).toBe(true);
    expect(r.method).toBe('review_timeout');
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

  it('propagates familyHarmSuspected only on hits', async () => {
    const d = new CrisisDetector(
      keywords,
      screener(false),
      reviewer({ ...hitResult, familyHarmSuspected: true }),
      fast,
    );
    expect((await d.check(input('死にたい'))).familyHarmSuspected).toBe(true);
    const d2 = new CrisisDetector(
      keywords,
      screener(false),
      reviewer({ ...missResult, familyHarmSuspected: true }),
      fast,
    );
    expect((await d2.check(input('死にたい'))).familyHarmSuspected).toBe(false);
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

  it('uses config defaults when no options are given', () => {
    expect(() => new CrisisDetector(keywords, screener(false), reviewer(hitResult))).not.toThrow();
  });
});
