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
  confidence: number;
  evidenceSpan?: string;
};

export interface SemanticScreener {
  screen(input: CrisisInput, signal: AbortSignal): Promise<{ suspect: boolean }>;
}

export interface CrisisReviewer {
  review(input: CrisisInput, signal: AbortSignal): Promise<ReviewResult>;
}

// モデル呼び出しが失敗した理由。quota（429 / RESOURCE_EXHAUSTED）はバックオフして1回再試行し、サーキットブレーカーにも数える
export type ModelFailureKind = 'quota' | 'timeout' | 'error';
export const MODEL_FAILURE_REASONS = [
  'model_error',
  'invalid_json',
  'schema',
  'inconsistent_verdict',
  'invalid_evidence',
] as const;
export type ModelFailureReason = (typeof MODEL_FAILURE_REASONS)[number];

export class ModelCallError extends Error {
  readonly reason?: ModelFailureReason;

  constructor(
    readonly kind: ModelFailureKind,
    reason?: ModelFailureReason,
  ) {
    super(`crisis_model_${kind}`);
    this.name = 'ModelCallError';
    if (reason && MODEL_FAILURE_REASONS.includes(reason)) this.reason = reason;
  }
}

// paused：キーワードに該当せず、モデルも使えない。ペットには渡さず、危機とも判定しない（安全側に倒す原則）
export type CrisisMethod = 'keyword' | 'screen' | 'review' | 'review_timeout' | 'paused' | 'none';

export type CrisisCheck = {
  availability?: 'verified' | 'unavailable';
  hit: boolean;
  category: CrisisCategory;
  // 常に category === 'family_harm' と等しい
  familyHarmSuspected: boolean;
  method: CrisisMethod;
  keywordMatched: boolean;
  confidence: number;
  latencyMs: number;
  evidenceSpan?: string;
};

export type ModelEvent = {
  layer: 'screen' | 'review';
  kind: ModelFailureKind | 'retry' | 'breaker_open' | 'breaker_skip';
  reason?: ModelFailureReason;
};

export type CrisisDetectorOptions = {
  screenTimeoutMs?: number;
  reviewTimeoutMs?: number;
  now?: () => number;
  // ログとアラート用に、層・種類・列挙型の理由だけを報告する。入力やモデルの生のレスポンスは含めない
  onModelEvent?: (event: ModelEvent) => void;
  breaker?: ModelBreaker;
  random?: () => number;
};

export function isPaused(check: Pick<CrisisCheck, 'method'>): boolean {
  return check.method === 'paused';
}

// 1分以内にクォータ関連のエラーが N 回連続したら、一定時間モデルを呼び出さない（docs/02「危機検知器」モデルが利用できないときの処理 第3項）
export class ModelBreaker {
  private failures: number[] = [];
  private openUntil = 0;

  constructor(
    private readonly now: () => number = () => performance.now(),
    private readonly opts: { windowMs: number; threshold: number; openMs: number } = {
      windowMs: crisisConfig.breakerWindowMs,
      threshold: crisisConfig.breakerThreshold,
      openMs: crisisConfig.breakerOpenMs,
    },
  ) {}

  get isOpen(): boolean {
    return this.now() < this.openUntil;
  }

  success(): void {
    this.failures = [];
  }

  // true を返したら、このエラーでサーキットブレーカーが開いた
  quotaFailure(): boolean {
    const at = this.now();
    this.failures = [...this.failures.filter((t) => at - t < this.opts.windowMs), at];
    if (this.failures.length < this.opts.threshold) return false;
    this.failures = [];
    this.openUntil = at + this.opts.openMs;
    return true;
  }
}

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

const HIT_ON_FAILURE: ReviewResult = { hit: true, category: 'other', confidence: 0 };

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('aborted'));
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });
}

function failureKind(err: unknown): ModelFailureKind {
  return err instanceof ModelCallError ? err.kind : 'error';
}

export class CrisisDetector {
  private readonly screenTimeoutMs: number;
  private readonly reviewTimeoutMs: number;
  private readonly now: () => number;
  private readonly onModelEvent: (event: ModelEvent) => void;
  private readonly breaker: ModelBreaker;
  private readonly random: () => number;

  constructor(
    private readonly keywords: KeywordMatcher,
    private readonly screener: SemanticScreener,
    private readonly reviewer: CrisisReviewer,
    opts: CrisisDetectorOptions = {},
  ) {
    this.screenTimeoutMs = opts.screenTimeoutMs ?? crisisConfig.screenTimeoutMs;
    this.reviewTimeoutMs = opts.reviewTimeoutMs ?? crisisConfig.reviewTimeoutMs;
    this.now = opts.now ?? (() => performance.now());
    this.onModelEvent = opts.onModelEvent ?? (() => {});
    this.breaker = opts.breaker ?? new ModelBreaker();
    this.random = opts.random ?? Math.random;
  }

  keywordOnly(text: string): boolean {
    return this.keywords.match(text).hit;
  }

  // サーキットブレーカーが開いている間：ペットは「ねむい」表情になり、入力ごとにモデルを待たない
  get modelUnavailable(): boolean {
    return this.breaker.isOpen;
  }

  async check(input: CrisisInput): Promise<CrisisCheck> {
    const started = this.now();
    const keyword = this.keywords.match(input.text);

    if (keyword.hit) {
      return this.finish(await this.reviewOrHit(input), true, started);
    }

    const screened = await this.callModel('screen', this.screenTimeoutMs, (signal) =>
      this.screener.screen(input, signal),
    );
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

    // スクリーニングが利用できなくても素通しはせず、再判定に回す。再判定も利用できなければこの入力を保留する
    const reviewed = await this.callModel('review', this.reviewTimeoutMs, (signal) =>
      this.reviewer.review(input, signal),
    );
    if (!reviewed.ok) {
      return {
        availability: 'unavailable',
        hit: false,
        category: 'none',
        familyHarmSuspected: false,
        method: 'paused',
        keywordMatched: false,
        confidence: 0,
        latencyMs: this.now() - started,
      };
    }
    const r = { ...reviewed.value, method: 'review' as const };
    return this.finish(r.hit ? r : { ...r, method: 'screen' }, false, started);
  }

  private async reviewOrHit(input: CrisisInput): Promise<ReviewResult & { method: CrisisMethod }> {
    const result = await this.callModel('review', this.reviewTimeoutMs, (signal) =>
      this.reviewer.review(input, signal),
    );
    if (!result.ok) return { ...HIT_ON_FAILURE, method: 'review_timeout' };
    return { ...result.value, method: 'review' };
  }

  // 1回のモデル呼び出し：全体の制限時間内で、クォータ関連のエラーはバックオフして1回再試行する。サーキットブレーカーが開いていればすぐに利用不可を返す
  private async callModel<T>(
    layer: ModelEvent['layer'],
    timeoutMs: number,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<Timed<T>> {
    if (this.breaker.isOpen) {
      this.onModelEvent({ layer, kind: 'breaker_skip' });
      return { ok: false };
    }
    let reported = false;
    const result = await withTimeout(timeoutMs, async (signal) => {
      for (let attempt = 0; ; attempt++) {
        try {
          const value = await run(signal);
          this.breaker.success();
          return value;
        } catch (err) {
          if (signal.aborted) throw err;
          const kind = failureKind(err);
          const reason = err instanceof ModelCallError ? err.reason : undefined;
          this.onModelEvent({ layer, kind, ...(reason ? { reason } : {}) });
          reported = true;
          if (kind !== 'quota') throw err;
          if (this.breaker.quotaFailure()) {
            this.onModelEvent({ layer, kind: 'breaker_open' });
            throw err;
          }
          if (attempt >= 1) throw err;
          reported = false;
          this.onModelEvent({ layer, kind: 'retry' });
          await sleep(
            crisisConfig.quotaRetryDelayMs + this.random() * crisisConfig.quotaRetryJitterMs,
            signal,
          );
        }
      }
    }).catch((): Timed<T> => ({ ok: false }));
    if (!result.ok && !reported) this.onModelEvent({ layer, kind: 'timeout' });
    return result;
  }

  private finish(
    r: ReviewResult & { method: CrisisMethod },
    keywordMatched: boolean,
    started: number,
  ): CrisisCheck {
    const category = !r.hit ? 'none' : r.category === 'none' ? 'other' : r.category;
    const out: CrisisCheck = {
      availability: r.method === 'review_timeout' ? 'unavailable' : 'verified',
      hit: r.hit,
      category,
      familyHarmSuspected: category === 'family_harm',
      method: r.method,
      keywordMatched,
      confidence: r.confidence,
      latencyMs: this.now() - started,
    };
    if (r.hit && r.evidenceSpan !== undefined) out.evidenceSpan = r.evidenceSpan;
    return out;
  }
}
