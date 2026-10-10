import { createHash } from 'node:crypto';

export function stableId(...parts: readonly (string | number)[]): string {
  const h = createHash('sha256');
  for (const p of parts) h.update(String(p)).update('\u0000');
  return h.digest('hex').slice(0, 24);
}

// ワンタイムチケットはダイジェストだけを保存する。保存先からダイジェストを取り出しても、使えるチケットには戻せない
export function tokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export const VOICE_TICKETS = 'voiceTickets';

export type Shard = { index: number; count: number };

// バッチ処理のシャード分割：同じ key はどの実行でも同じシャードに入る
export function shardOf(key: string, count: number): number {
  if (!Number.isInteger(count) || count < 1) throw new Error('shard count must be >= 1');
  return createHash('sha256').update(key).digest().readUInt32BE(0) % count;
}

export function inShard(key: string, shard: Shard): boolean {
  return shard.count <= 1 || shardOf(key, shard.count) === shard.index;
}

// Cloud Run Jobs は task ごとに CLOUD_RUN_TASK_INDEX / CLOUD_RUN_TASK_COUNT を注入する
export function jobShard(env: Record<string, string | undefined> = process.env): Shard {
  const count = Number(env['CLOUD_RUN_TASK_COUNT'] ?? '1');
  const index = Number(env['CLOUD_RUN_TASK_INDEX'] ?? '0');
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    !Number.isInteger(index) ||
    index < 0 ||
    index >= count
  )
    throw new Error('invalid CLOUD_RUN_TASK_INDEX / CLOUD_RUN_TASK_COUNT');
  return { index, count };
}
