import { childPath, type ChildRecord } from '@ijime/agent-core';
import type { CrisisPayload } from '@ijime/api-types';
import {
  crisisEventDoc,
  crisisResponse,
  isPaused,
  routingOfCheck,
  type CrisisCheck,
  type CrisisTrigger,
} from '@ijime/crisis-detector';
import { ApiHttpError } from '@ijime/service-kit';

import { checkWithinBudget, rejectPaused } from '../model-budget.js';
import { persistSubmission } from '../submission-store.js';
import type { SubmissionDeps } from './submissions.js';

export type GuardDeps = Pick<
  SubmissionDeps,
  | 'db'
  | 'directory'
  | 'detector'
  | 'safeModeCopy'
  | 'hotlines'
  | 'pausedReplies'
  | 'logger'
  | 'publish'
  | 'now'
>;

export async function submissionOwner(deps: GuardDeps, childId: string) {
  const child = await deps.directory.lookup(childId);
  if (!child) throw new ApiHttpError('NOT_FOUND', 'unknown child');
  const doc = (await deps.db.doc(childPath(child.familyId, childId)).get()).data();
  if (doc?.['status'] !== 'active') throw new ApiHttpError('PERMISSION_DENIED', '利用できません');
  const sources = (doc?.['dataSources'] ?? {}) as Record<string, boolean>;
  return { child, base: childPath(child.familyId, childId), sources };
}

// 語りは子どもの入力なので、先に危機検知を通す。キーワードがヒットした場合はモデルが使えなくても危機として扱う。
// ヒットせず、モデルの結論も得られないときはこの提出を拒否し、子どもに再提出してもらう
export async function checkNarrative(
  deps: GuardDeps,
  child: ChildRecord,
  text: string,
): Promise<CrisisCheck | undefined> {
  if (!text.trim()) return undefined;
  const check = await checkWithinBudget(
    { db: deps.db, detector: deps.detector, now: deps.now },
    child,
    childPath(child.familyId, child.childId),
    { text, gradeBand: child.gradeBand, priorTurns: [] },
  );
  deps.logger.info('crisis.check', {
    pseudoId: child.childId,
    hit: check.hit,
    method: check.method,
    category: check.category,
    latencyMs: Math.round(check.latencyMs),
  });
  if (isPaused(check)) rejectPaused(deps.pausedReplies[child.gradeBand]);
  return check;
}

export async function raiseCrisis(
  deps: GuardDeps,
  child: ChildRecord,
  triggerType: CrisisTrigger,
  sourceRef: string,
  check: CrisisCheck,
): Promise<CrisisPayload> {
  const base = childPath(child.familyId, child.childId);
  const ref = deps.db.collection(`${base}/crisisEvents`).doc();
  await persistSubmission(
    deps.db,
    base,
    ref,
    crisisEventDoc({ triggerType, sourceRef, check, now: deps.now() }),
  );
  const routing = routingOfCheck(check);
  await deps.publish('crisis.detected', { childId: child.childId, crisisId: ref.id, ...routing });
  deps.logger.warn('crisis.detected', {
    pseudoId: child.childId,
    crisisId: ref.id,
    source: triggerType,
    ...routing,
  });
  const { message, resources } = crisisResponse({
    familyHarmSuspected: check.familyHarmSuspected,
    gradeBand: child.gradeBand,
    copy: deps.safeModeCopy,
    hotlines: deps.hotlines,
  });
  return { crisisId: ref.id, message, resources };
}
