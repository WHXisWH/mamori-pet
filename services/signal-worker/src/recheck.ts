import {
  crisisEventDoc,
  isPaused,
  routingOfCheck,
  routingOfRecord,
  type CrisisRouting,
} from '@ijime/crisis-detector';
import { SkipEvent, stableId, type CrisisRecheckTask } from '@ijime/service-kit';

import type { SignalWorkerDeps } from './deps.js';
import { childDocPath, readChild } from './store.js';

const PRIOR_TURNS = 5;

export class RecheckStillPaused extends Error {
  constructor() {
    super('crisis recheck: models still unavailable');
  }
}

// モデルが利用できず保留になった入力をここで再審査する。crisisId が決定論的なので、Cloud Tasks の再投入でイベントが二重に作られない。
// イベントを先に発行し、pendingReview は最後に消す。途中で失敗した再投入は作成済みの危機記録を使い回してもう一度発行する。
export async function handleCrisisRecheck(
  deps: SignalWorkerDeps,
  task: CrisisRecheckTask,
): Promise<void> {
  const { db, logger } = deps;
  const { familyId, childId, sessionId, messageId, channel } = task;
  const child = await readChild(db, familyId, childId);
  if (!child) throw new SkipEvent('child_not_found');
  const ctx = await deps.sessions.readMessageContext(childId, sessionId, messageId, PRIOR_TURNS);
  if (!ctx) throw new SkipEvent('source_deleted');
  if (ctx.message.role !== 'child') throw new SkipEvent('not_child_message');
  if (ctx.message.crisisCheck?.pendingReview !== true) throw new SkipEvent('already_rechecked');

  const base = childDocPath(familyId, childId);
  const sourceRef = `${base}/sessions/${sessionId}/messages/${messageId}`;
  const crisisRef = db.doc(`${base}/crisisEvents/recheck_${stableId(sessionId, messageId)}`);
  const existing = await crisisRef.get();

  let routing: CrisisRouting | undefined;
  let crisisCheck: { hit: boolean; method: string; score: number };
  if (existing.exists) {
    routing = routingOfRecord(existing.data() ?? {});
    crisisCheck = {
      hit: true,
      method: String(existing.get('detection.method') ?? 'review'),
      score: Number(existing.get('detection.confidence') ?? 0),
    };
  } else {
    const check = await deps.detector.check({
      text: ctx.message.text,
      gradeBand: child.gradeBand,
      priorTurns: ctx.prior.filter((p) => p.role === 'child').map((p) => p.text),
    });
    if (isPaused(check)) {
      logger.warn('crisis.recheck_paused', { pseudoId: childId, sessionId, messageId });
      throw new RecheckStillPaused();
    }
    crisisCheck = { hit: check.hit, method: check.method, score: check.confidence };
    if (check.hit) {
      const now = deps.now();
      await db.runTransaction(async (tx) => {
        const owner = await tx.get(db.doc(base));
        if (!owner.exists || (owner.get('status') && owner.get('status') !== 'active'))
          throw new SkipEvent('child_not_found');
        tx.create(
          crisisRef,
          crisisEventDoc({ triggerType: channel, sourceRef, check, now, delayed: true }),
        );
      });
      routing = routingOfCheck(check);
    }
  }

  if (routing) {
    await deps.sessions.markSafeMode(childId, sessionId);
    await deps.publisher.publish('crisis.detected', {
      childId,
      crisisId: crisisRef.id,
      ...routing,
      delayed: true,
    });
    logger.warn('crisis.detected', {
      pseudoId: childId,
      crisisId: crisisRef.id,
      source: 'recheck',
      ...routing,
    });
  }
  await deps.publisher.publish('message.created', {
    familyId,
    childId,
    sessionId,
    messageId,
    channel,
  });
  await db.doc(sourceRef).update({
    'crisisCheck.hit': crisisCheck.hit,
    'crisisCheck.method': crisisCheck.method,
    'crisisCheck.score': crisisCheck.score,
    'crisisCheck.pendingReview': false,
    'crisisCheck.recheckedAt': deps.now(),
  });
  logger.info('crisis.rechecked', {
    pseudoId: childId,
    sessionId,
    messageId,
    hit: crisisCheck.hit,
  });
}
