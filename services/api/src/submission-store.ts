import type { DocumentData, DocumentReference, Firestore } from '@google-cloud/firestore';
import { ApiHttpError } from '@ijime/service-kit';

// Recheck at commit: a model call can finish after the child requested deletion.
export async function persistSubmission(
  db: Firestore,
  childPath: string,
  ref: DocumentReference,
  data: DocumentData,
): Promise<void> {
  await db.runTransaction(async (tx) => {
    const owner = await tx.get(db.doc(childPath));
    if (!owner.exists || owner.get('status') !== 'active')
      throw new ApiHttpError('PERMISSION_DENIED', '利用できません');
    tx.create(ref, data);
  });
}
