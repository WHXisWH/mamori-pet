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
