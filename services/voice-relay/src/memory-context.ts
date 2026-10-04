import type { Firestore, Timestamp } from '@google-cloud/firestore';
import { childPath, type ChildRecord, type FirestoreSessionService } from '@ijime/agent-core';
import { agent, limits } from '@ijime/config';

const millis = (value: unknown): number => {
  if (value instanceof Date) return value.getTime();
  if (value && typeof (value as Timestamp).toMillis === 'function')
    return (value as Timestamp).toMillis();
  return NaN;
};

// Bound setup reads. The topic comes only from retained, screened conversation,
// never from an unchecked microphone transcript or a previous pet's messages.
export async function recentScreenedTopic(input: {
  db: Firestore;
  sessions: FirestoreSessionService;
  child: ChildRecord;
  resetAt: unknown;
  now: Date;
}): Promise<string | undefined> {
  const base = childPath(input.child.familyId, input.child.childId);
  const now = input.now.getTime();
  const resetAt = millis(input.resetAt);
  const sessions = await input.db
    .collection(`${base}/sessions`)
    .orderBy('startedAt', 'desc')
    .limit(3)
    .get();
  let latest: { at: number; path: string; encrypted: Buffer } | undefined;
  for (const session of sessions.docs) {
    if (
      session.get('petId') !== input.child.petId ||
      session.get('safeMode') === true ||
      !(millis(session.get('expireAt')) > now)
    )
      continue;
    const messages = await session.ref
      .collection('messages')
      .orderBy('createdAt', 'desc')
      .limit(agent.contextHistoryTurns * 2)
      .get();
    for (const message of messages.docs) {
      const at = millis(message.get('createdAt'));
      if (
        message.get('role') !== 'child' ||
        message.get('crisisCheck.hit') !== false ||
        !Number.isFinite(at) ||
        at > now ||
        at <= (Number.isFinite(resetAt) ? resetAt : 0) ||
        !(millis(message.get('expireAt')) > now) ||
        (latest && at <= latest.at)
      )
        continue;
      const encrypted: unknown = message.get('contentEnc');
      if (!Buffer.isBuffer(encrypted) && !(encrypted instanceof Uint8Array)) continue;
      latest = { at, path: message.ref.parent.path, encrypted: Buffer.from(encrypted) };
    }
  }
  if (!latest) return undefined;
  const topic = input.sessions.decryptForChild(
    input.child,
    latest.encrypted,
    `${latest.path}#contentEnc`,
  );
  return topic.trim().slice(0, limits.messageText.max) || undefined;
}
