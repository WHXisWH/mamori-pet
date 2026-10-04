import type { QueryDocumentSnapshot } from '@google-cloud/firestore';
import type { CrisisPayload, GradeBand } from '@ijime/api-types';
import { crisisResponse } from '@ijime/crisis-detector';

import type { ChatDeps } from '../chat.js';

export function activeCrisisQuery(deps: ChatDeps, base: string) {
  return deps.db
    .collection(`${base}/crisisEvents`)
    .where('status', 'in', ['open', 'guardian_acknowledged']);
}

export function activeCrisisPayload(
  deps: ChatDeps,
  gradeBand: GradeBand,
  docs: QueryDocumentSnapshot[],
): CrisisPayload | undefined {
  // One safe-family record must not conceal another unresolved family-harm record.
  const record = docs.find((d) => d.get('familyHarmSuspected') !== false) ?? docs[0];
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
