import type { MiddlewareHandler } from 'hono';

import { ApiHttpError } from './errors.js';

const WINDOW_MS = 60_000;
const MAX_TRACKED_KEYS = 10_000;

export type RateLimiter = { allow(key: string): boolean };

// プロセス内の固定ウィンドウのカウント。インスタンスごとに別々に数えるので、実際の上限は limit × インスタンス数。
// 目的はスクリプトによる連打を止めることで、正確なクォータではない（正確な1日の上限は Firestore にある）。
export function createRateLimiter(
  limit: number,
  windowMs: number = WINDOW_MS,
  now: () => number = Date.now,
): RateLimiter {
  const windows = new Map<string, { startedAt: number; count: number }>();
  return {
    allow(key) {
      const at = now();
      const current = windows.get(key);
      if (!current || at - current.startedAt >= windowMs) {
        if (windows.size >= MAX_TRACKED_KEYS) {
          for (const [k, w] of windows) if (at - w.startedAt >= windowMs) windows.delete(k);
          if (windows.size >= MAX_TRACKED_KEYS) windows.clear();
        }
        windows.set(key, { startedAt: at, count: 1 });
        return true;
      }
      if (current.count >= limit) return false;
      current.count += 1;
      return true;
    },
  };
}

// 汎用ミドルウェア：keyOf が undefined を返すリクエストは数えない（相談窓口の取得など、常に使えなければならないエンドポイント）
export function rateLimitMiddleware(
  limiter: RateLimiter,
  keyOf: (c: Parameters<MiddlewareHandler>[0]) => string | undefined,
  message: string,
): MiddlewareHandler {
  return async (c, next) => {
    const key = keyOf(c);
    if (key !== undefined && !limiter.allow(key)) throw new ApiHttpError('RATE_LIMITED', message);
    await next();
  };
}

export type Subject = 'child' | 'guardian';

const SUBJECT_MESSAGES: Record<Subject, string> = {
  child: '少し待ってから、もう一度ためしてね。困ったときの連絡先はいつでも開けるよ。',
  guardian: '短い時間に操作が続きました。少し時間をおいてから、もう一度お試しください。',
};

export type SubjectRateLimit = {
  // 同じリクエストが複数の認証ミドルウェアを通っても1回だけ数える（リクエストの Headers オブジェクトで重複を除く）
  check(request: { headers: Headers }, subject: Subject, id: string): void;
};

export function createSubjectRateLimit(
  perMinute: Record<Subject, number>,
  now: () => number = Date.now,
): SubjectRateLimit {
  const limiters: Record<Subject, RateLimiter> = {
    child: createRateLimiter(perMinute.child, WINDOW_MS, now),
    guardian: createRateLimiter(perMinute.guardian, WINDOW_MS, now),
  };
  const counted = new WeakSet<Headers>();
  return {
    check(request, subject, id) {
      if (counted.has(request.headers)) return;
      counted.add(request.headers);
      if (!limiters[subject].allow(id))
        throw new ApiHttpError('RATE_LIMITED', SUBJECT_MESSAGES[subject]);
    },
  };
}
