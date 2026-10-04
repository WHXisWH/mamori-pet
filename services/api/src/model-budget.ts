import type { Firestore } from '@google-cloud/firestore';
import { agent, limits, rateLimit } from '@ijime/config';
import type { CrisisCheck, CrisisDetector, CrisisInput } from '@ijime/crisis-detector';
import { ApiHttpError } from '@ijime/service-kit';

// 費用の上限。モデルは動的な共有クォータで動き、Google 側にはプロジェクト単位の上限がない。
// そのため、モデル呼び出しを起こす子ども側の入口は、すべて先にここを通す。

const REST_MESSAGE = '今日は少し休けいしよう。困ったときの連絡先はいつでも開けるよ。';
const SLOW_DOWN_MESSAGE =
  '少し待ってから、もう一度送ってね。困ったときの連絡先はいつでも開けるよ。';
const WINDOW_MS = 60_000;
const MAX_TRACKED_KEYS = 10_000;

export type RateLimiter = { allow(key: string): boolean };

// プロセス内の固定ウィンドウでのカウント。インスタンスごとに別々に数えるため、実際の上限は limit × インスタンス数になる。
// 目的はスクリプトによる大量リクエストを止めることで、厳密なクォータではない（厳密な1日の上限は Firestore にある）。
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

const jstDate = (now: Date) => new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);

export type DailyCounter = 'checks' | 'artworks';
const DAILY_LIMITS: Record<DailyCounter, number> = {
  checks: agent.dailyModelCheckLimit,
  artworks: limits.artworksPerDay,
};

// 当日のカウントを 1 増やす。すでに上限なら増やさず false を返す。chatUsage/{date}（会話のターン数。全体が上書きされる）とは別に保存する。
export async function consumeDaily(
  db: Firestore,
  childBase: string,
  counter: DailyCounter,
  now: Date,
): Promise<boolean> {
  const ref = db.doc(`${childBase}/chatUsage/${jstDate(now)}_model`);
  return db.runTransaction(async (tx) => {
    const used = Number((await tx.get(ref)).get(counter) ?? 0);
    if (used >= DAILY_LIMITS[counter]) return false;
    tx.set(
      ref,
      { [counter]: used + 1, expireAt: new Date(now.getTime() + 2 * 86_400_000) },
      { merge: true },
    );
    return true;
  });
}

export type BudgetDeps = {
  db: Firestore;
  detector: CrisisDetector;
  limiter?: RateLimiter;
  now?: () => Date;
};

const defaultLimiter = createRateLimiter(rateLimit.childModelRequestsPerMinute);

// 上限に達しているときにキーワードがヒットした場合の結果：危機として扱い、カテゴリは不明とする。検知器が再確認のタイムアウト時に取る保守的な値と同じ
// （家庭が安全かどうか分からないときは、保護者にそっと通知せず、まず家庭外の相談先を示す）。
const KEYWORD_HIT_WITHOUT_MODEL: CrisisCheck = {
  availability: 'unavailable',
  hit: true,
  category: 'none',
  familyHarmSuspected: true,
  method: 'keyword',
  keywordMatched: true,
  confidence: 0,
  latencyMs: 0,
};

// 上限つきの危機検知。1分あたりと1日あたりの上限内なら、通常どおり完全な検知（キーワード、スクリーニング、再確認）を行う。
// 上限を超えたあとはモデルを一切呼び出さない：
// - キーワード層は通常どおり判定する（決定論的で費用がかからない）。ヒットしたら危機として扱う。
// - ヒットしなければその入力を拒否し（ペットに渡さず、保存もしない）、定型文を返す。相談窓口への入口は通常どおり使える。
export async function checkWithinBudget(
  deps: BudgetDeps,
  child: { childId: string },
  childBase: string,
  input: CrisisInput,
): Promise<CrisisCheck> {
  const perMinute = (deps.limiter ?? defaultLimiter).allow(child.childId);
  const withinBudget =
    perMinute &&
    (await consumeDaily(deps.db, childBase, 'checks', (deps.now ?? (() => new Date()))()));
  if (withinBudget) return deps.detector.check(input);
  if (deps.detector.keywordOnly(input.text)) return { ...KEYWORD_HIT_WITHOUT_MODEL };
  throw new ApiHttpError('RATE_LIMITED', perMinute ? REST_MESSAGE : SLOW_DOWN_MESSAGE);
}

export async function consumeArtwork(db: Firestore, childBase: string, now: Date): Promise<void> {
  if (!(await consumeDaily(db, childBase, 'artworks', now)))
    throw new ApiHttpError(
      'RATE_LIMITED',
      '今日はたくさん見せてくれたね。続きはまた明日にしよう。',
    );
}
