import type { Firestore } from '@google-cloud/firestore';
import { rateLimit } from '@ijime/config';

export const PAIRING_ATTEMPTS = 'pairingAttempts';

export type PairingLimit = { perMinute: number; shards: number };

const DEFAULT_LIMIT: PairingLimit = {
  perMinute: rateLimit.childRequestsPerMinute,
  shards: rateLimit.pairingShards,
};

// 各シャードの上限の合計が全体の上限に等しいので、いくつのプロセスが並行しても1分間に通過する総数は perMinute を超えない
export function shardCaps(limit: PairingLimit): number[] {
  const base = Math.floor(limit.perMinute / limit.shards);
  const extra = limit.perMinute % limit.shards;
  return Array.from({ length: limit.shards }, (_, i) => base + (i < extra ? 1 : 0));
}

// 匿名ペアリングの全体制限：暦の分ごとに数え、ランダムなシャードから始めて、いっぱいなら次のシャードに移る。
// 1回のトランザクションは1つのシャード文書だけを対象にし、すべてのリクエストが同じ文書を取り合うのを避ける。IP も子どもの内容も記録しない
export async function takePairingSlot(
  db: Firestore,
  now: Date,
  limit: PairingLimit = DEFAULT_LIMIT,
  random: () => number = Math.random,
): Promise<boolean> {
  const window = Math.floor(now.getTime() / 60_000);
  const caps = shardCaps(limit);
  const start = Math.floor(random() * limit.shards);
  for (let k = 0; k < limit.shards; k++) {
    const i = (start + k) % limit.shards;
    const cap = caps[i]!;
    if (cap === 0) continue;
    const ref = db.doc(`${PAIRING_ATTEMPTS}/public-${i}`);
    let taken: boolean;
    try {
      taken = await db.runTransaction(
        async (tx) => {
          const saved = await tx.get(ref);
          const savedWindow = Number(saved.get('window') ?? -1);
          // 遅れて届いたリクエストが、より新しい分のウィンドウをリセットしてはいけない
          if (savedWindow > window) return false;
          const count = savedWindow === window ? Number(saved.get('count') ?? 0) : 0;
          if (count >= cap) return false;
          tx.set(ref, {
            window,
            count: count + 1,
            expiresAt: new Date((window + 2) * 60_000),
          });
          return true;
        },
        { maxAttempts: TRANSACTION_ATTEMPTS },
      );
    } catch (error) {
      // 競合でリトライを使い切ったら、このシャードは満杯とみなす。すべて競合で失敗した場合は制限として拒否し、500 は返さない
      if (!isAborted(error)) throw error;
      taken = false;
    }
    if (taken) return true;
  }
  return false;
}

// 競合時はリトライを少なくして早めに次のシャードへ移り、1つのシャードで長く待たせない
const TRANSACTION_ATTEMPTS = 2;
const ABORTED = 10;
function isAborted(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === ABORTED;
}
