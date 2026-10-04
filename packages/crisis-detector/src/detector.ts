import type { CrisisCategory, GradeBand } from '@ijime/api-types';
import { crisis as crisisConfig } from '@ijime/config';

import type { KeywordMatcher } from './keyword.js';

export type CrisisInput = {
  text: string;
  gradeBand: GradeBand;
  priorTurns: readonly string[];
};

export type ReviewResult = {
  hit: boolean;
  category: CrisisCategory;
  familyHarmSuspected: boolean;
  confidence: number;
  evidenceSpan?: string;
};

export interface SemanticScreener {
  screen(input: CrisisInput, signal: AbortSignal): Promise<{ suspect: boolean }>;
}

export interface CrisisReviewer {
  review(input: CrisisInput, signal: AbortSignal): Promise<ReviewResult>;
}

export type CrisisMethod = 'keyword' | 'screen' | 'review' | 'review_timeout' | 'none';

export type CrisisCheck = {
  availability?: 'verified' | 'unavailable';
  hit: boolean;
  category: CrisisCategory;
  familyHarmSuspected: boolean;
  method: CrisisMethod;
  keywordMatched: boolean;
  confidence: number;
  latencyMs: number;
  evidenceSpan?: string;
};

export type CrisisDetectorOptions = {
  screenTimeoutMs?: number;
  reviewTimeoutMs?: number;
  now?: () => number;
};

type Timed<T> = { ok: true; value: T } | { ok: false };

async function withTimeout<T>(
  ms: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<Timed<T>> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<Timed<T>>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ ok: false });
    }, ms);
  });
  try {
    return await Promise.race([
      run(controller.signal).then((value): Timed<T> => ({ ok: true, value })),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const HIT_ON_FAILURE: ReviewResult = {
  hit: true,
  category: 'none',
  // Unknown routing must not silently notify a potentially unsafe guardian.
  familyHarmSuspected: true,
  confidence: 0,
};

export class CrisisDetector {
  private readonly screenTimeoutMs: number;
  private readonly reviewTimeoutMs: number;
  private readonly now: () => number;

  constructor(
    private readonly keywords: KeywordMatcher,
    private readonly screener: SemanticScreener,
    private readonly reviewer: CrisisReviewer,
    opts: CrisisDetectorOptions = {},
  ) {
    this.screenTimeoutMs = opts.screenTimeoutMs ?? crisisConfig.screenTimeoutMs;
    this.reviewTimeoutMs = opts.reviewTimeoutMs ?? crisisConfig.reviewTimeoutMs;
    this.now = opts.now ?? (() => performance.now());
  }

  keywordOnly(text: string): boolean {
    return this.keywords.match(text).hit;
  }

  async check(input: CrisisInput): Promise<CrisisCheck> {
    const started = this.now();
    const keyword = this.keywords.match(input.text);

    if (keyword.hit) {
      return this.finish(await this.reviewOrHit(input), true, started);
    }

    const screened = await withTimeout(this.screenTimeoutMs, (signal) =>
      this.screener.screen(input, signal),
    ).catch((): Timed<{ suspect: boolean }> => ({ ok: false }));
    if (screened.ok && !screened.value.suspect) {
      return {
        availability: 'verified',
        hit: false,
        category: 'none',
        familyHarmSuspected: false,
        method: 'none',
        keywordMatched: false,
        confidence: 0,
        latencyMs: this.now() - started,
      };
    }

    const reviewed = await this.reviewOrHit(input);
    return this.finish(reviewed.hit ? reviewed : { ...reviewed, method: 'screen' }, false, started);
  }

  private async reviewOrHit(input: CrisisInput): Promise<ReviewResult & { method: CrisisMethod }> {
    const result = await withTimeout(this.reviewTimeoutMs, (signal) =>
      this.reviewer.review(input, signal),
    ).catch((): Timed<ReviewResult> => ({ ok: false }));
    if (!result.ok) return { ...HIT_ON_FAILURE, method: 'review_timeout' };
    return { ...result.value, method: 'review' };
  }

  private finish(
    r: ReviewResult & { method: CrisisMethod },
    keywordMatched: boolean,
    started: number,
  ): CrisisCheck {
    const out: CrisisCheck = {
      availability: r.method === 'review_timeout' ? 'unavailable' : 'verified',
      hit: r.hit,
      category: r.hit ? r.category : 'none',
      familyHarmSuspected: r.hit && r.familyHarmSuspected,
      method: r.method,
      keywordMatched,
      confidence: r.confidence,
      latencyMs: this.now() - started,
    };
    if (r.hit && r.evidenceSpan !== undefined) out.evidenceSpan = r.evidenceSpan;
    return out;
  }
}
