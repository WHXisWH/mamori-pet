import type { Firestore } from '@google-cloud/firestore';
import { agent, limits, rateLimit } from '@ijime/config';
import type { CrisisCheck, CrisisDetector, CrisisInput } from '@ijime/crisis-detector';
import { ApiHttpError, createRateLimiter, type RateLimiter } from '@ijime/service-kit';

// 費用の上限。モデルは動的な共有クォータで動き、Google 側にはプロジェクト単位の上限がない。
// そのため、モデル呼び出しを起こす子ども側の入口は、すべて先にここを通す。

const REST_MESSAGE = '今日は少し休けいしよう。困ったときの連絡先はいつでも開けるよ。';
const SLOW_DOWN_MESSAGE =
  '少し待ってから、もう一度送ってね。困ったときの連絡先はいつでも開けるよ。';
export { createRateLimiter, type RateLimiter } from '@ijime/service-kit';

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

// 上限に達しているときにキーワードがヒットした場合の結果：危機として扱う。モデルの分類は得られないため、カテゴリは other とする（保護者に通知する。2026-10-05 決定）
const KEYWORD_HIT_WITHOUT_MODEL: CrisisCheck = {
  availability: 'unavailable',
  hit: true,
  category: 'other',
  familyHarmSuspected: false,
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

// 作品の語りや大人向けの要約など、メッセージとして保存しない入力：モデルが使えないときはその場で拒否し、内容は保存せず誰にも渡さない。
// 子どもは定型文を受け取ってから再提出する（会話メッセージは保存して再審査する。chat.ts を参照）
export function rejectPaused(message: string): never {
  throw new ApiHttpError('MODEL_UNAVAILABLE', message);
}

export async function consumeArtwork(db: Firestore, childBase: string, now: Date): Promise<void> {
  if (!(await consumeDaily(db, childBase, 'artworks', now)))
    throw new ApiHttpError(
      'RATE_LIMITED',
      '今日はたくさん見せてくれたね。続きはまた明日にしよう。',
    );
}
