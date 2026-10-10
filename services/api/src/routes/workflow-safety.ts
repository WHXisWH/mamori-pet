import type { QueryDocumentSnapshot } from '@google-cloud/firestore';
import type { CrisisPayload, GradeBand } from '@ijime/api-types';
import { ACTIVE_CRISIS_STATUSES, isCrisisLockingChild } from '@ijime/config';
import { crisisResponse } from '@ijime/crisis-detector';

import type { ChatDeps } from '../chat.js';

export function activeCrisisQuery(deps: ChatDeps, base: string) {
  return deps.db.collection(`${base}/crisisEvents`).where('status', 'in', ACTIVE_CRISIS_STATUSES);
}

export function activeCrisisPayload(
  deps: ChatDeps,
  gradeBand: GradeBand,
  docs: QueryDocumentSnapshot[],
): CrisisPayload | undefined {
  // 保護者の確認から 24 時間たったイベントは終了扱い。子ども自身が安全を確認した家庭内危害のイベントは、すぐに子どものロックを解除する（2026-10-10 決定）
  const now = new Date();
  const active = docs.filter((d) => isCrisisLockingChild(d.data(), now));
  // One safe-family record must not conceal another unresolved family-harm record.
  const record = active.find((d) => d.get('familyHarmSuspected') !== false) ?? active[0];
  if (!record) return undefined;
  return {
    crisisId: record.id,
    ...crisisResponse({
      familyHarmSuspected: record.get('familyHarmSuspected') !== false,
      gradeBand,
      copy: deps.safeModeCopy,
      hotlines: deps.hotlines,
    }),
  };
}

export async function readActiveCrisis(deps: ChatDeps, gradeBand: GradeBand, base: string) {
  return activeCrisisPayload(deps, gradeBand, (await activeCrisisQuery(deps, base).get()).docs);
}
