import type { ChildRecord } from '@ijime/agent-core';
import type { ChatSafetyRes } from '@ijime/api-types';
import { agent as agentConfig } from '@ijime/config';
import { crisisResponse, routingOfRecord } from '@ijime/crisis-detector';
import { ApiHttpError } from '@ijime/service-kit';

import type { ChatDeps } from './chat.js';

export async function chatSafety(
  deps: ChatDeps,
  child: ChildRecord,
  sessionId: string,
): Promise<ChatSafetyRes> {
  const base = `families/${child.familyId}/children/${child.childId}`;
  const session = deps.db.doc(`${base}/sessions/${sessionId}`);
  const [stored, crises, pending] = await Promise.all([
    session.get(),
    deps.db.collection(`${base}/crisisEvents`).where('status', '==', 'open').limit(1).get(),
    session.collection('messages').where('crisisCheck.pendingReview', '==', true).limit(1).get(),
  ]);
  if (!stored.exists) throw new ApiHttpError('NOT_FOUND', 'unknown session');
  if (!crises.empty || stored.get('safeMode') === true) {
    const active = crises.docs[0];
    return {
      status: 'crisis',
      crisis: {
        crisisId: active?.id ?? sessionId,
        ...crisisResponse({
          familyHarmSuspected: routingOfRecord(active?.data() ?? {}).familyHarmSuspected,
          gradeBand: child.gradeBand,
          copy: deps.safeModeCopy,
          hotlines: deps.hotlines,
        }),
      },
    };
  }
  if (!pending.empty) return pendingReview(deps, child, pending.docs[0]!.id);
  const latestId: unknown = stored.get('latestInputMessageId');
  if (typeof latestId === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(latestId)) {
    const latest = await session.collection('messages').doc(latestId).get();
    if (
      latest.get('role') === 'child' &&
      latest.get('crisisCheck.hit') === false &&
      latest.get('crisisCheck.pendingReview') !== true &&
      latest.get('expireAt')?.toMillis() > Date.now() &&
      ['awaiting_review', 'retryable'].includes(String(latest.get('replyState')))
    )
      return { status: 'clear', resumeMessageId: latestId };
  }
  return { status: 'clear' };
}

export function pendingReview(
  deps: ChatDeps,
  child: ChildRecord,
  messageId: string,
): Extract<ChatSafetyRes, { status: 'pending_review' }> {
  return {
    status: 'pending_review',
    messageId,
    message: deps.pausedReplies[child.gradeBand],
    // Unavailable is not a category: offer all fixed resources, without notifying anyone.
    resources: [
      ...deps.hotlines.filter((resource) => resource.id === 'emergency'),
      ...deps.hotlines.filter((resource) => resource.id === 'jidou_soudan'),
      ...deps.hotlines.filter((resource) => !['emergency', 'jidou_soudan'].includes(resource.id)),
    ],
  };
}

export async function claimReply(
  deps: ChatDeps,
  child: ChildRecord,
  sessionId: string,
  messageId: string,
) {
  const base = `families/${child.familyId}/children/${child.childId}`;
  const sessionRef = deps.db.doc(`${base}/sessions/${sessionId}`);
  const ref = sessionRef.collection('messages').doc(messageId);
  await deps.db.runTransaction(async (tx) => {
    const owner = await tx.get(deps.db.doc(base));
    const session = await tx.get(sessionRef);
    const message = await tx.get(ref);
    const date = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
    const usageRef = deps.db.doc(`${base}/chatUsage/${date}`);
    const usage = await tx.get(usageRef);
    const crises = await tx.get(
      deps.db.collection(`${base}/crisisEvents`).where('status', '==', 'open').limit(1),
    );
    if (!owner.exists || owner.get('status') !== 'active' || !session.exists || !message.exists)
      throw new ApiHttpError('NOT_FOUND', 'unknown message');
    if (
      !crises.empty ||
      session.get('safeMode') === true ||
      session.get('latestInputMessageId') !== messageId ||
      message.get('role') !== 'child' ||
      message.get('crisisCheck.pendingReview') === true ||
      message.get('crisisCheck.hit') !== false ||
      !(message.get('expireAt')?.toMillis() > Date.now()) ||
      !['awaiting_review', 'retryable'].includes(String(message.get('replyState')))
    )
      throw new ApiHttpError('ALREADY_EXISTS', 'このメッセージは今は再開できません');
    // A paused input has not consumed a normal turn; retries of one turn do not count again.
    if (message.get('replyState') === 'awaiting_review') {
      const turns = Number(usage.get('turns') ?? 0);
      if (turns >= agentConfig.dailyTurnLimit)
        throw new ApiHttpError('RATE_LIMITED', '今日は少し休けいしよう。');
      tx.set(usageRef, { turns: turns + 1, expireAt: new Date(Date.now() + 2 * 86_400_000) });
    }
    tx.update(ref, { replyState: 'generating' });
  });
}
