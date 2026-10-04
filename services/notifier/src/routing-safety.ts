import type { DocumentSnapshot, Firestore, Transaction } from '@google-cloud/firestore';
import { SkipEvent } from '@ijime/service-kit';

import { childDocPath, notificationPath, type NotificationDoc } from './store.js';

export async function readRoutingBlock(
  tx: Transaction,
  db: Firestore,
  familyId: string,
  childId: string,
): Promise<string | undefined> {
  const base = childDocPath(familyId, childId);
  const child = await tx.get(db.doc(base));
  const status = child.get('status');
  if (!child.exists || (status !== undefined && status !== 'active')) return 'child_inactive';
  const crises = await tx.get(db.collection(`${base}/crisisEvents`));
  if (
    crises.docs.some(
      (crisis) => crisis.get('status') !== 'closed' && crisis.get('familyHarmSuspected') !== false,
    )
  )
    return 'guardian_routing_unsafe';
  return undefined;
}

// Keep a terminal record so retries cannot restore the draft after the crisis closes.
// Clear the whole payload: generated text can also contain sensitive derivatives.
export function redactNotification(tx: Transaction, snap: DocumentSnapshot): void {
  if (!snap.exists) return;
  tx.update(snap.ref, {
    status: 'failed',
    recipientIds: [],
    channels: [],
    templateId: '',
    payload: {
      title: '',
      changes: [],
      meaning: '',
      suggestions: { try: [], avoid: [] },
      childSummary: null,
      resources: [],
      reason: { domains: [], days: 0 },
    },
  });
}

export async function checkedNotification(
  db: Firestore,
  familyId: string,
  notificationId: string,
): Promise<NotificationDoc> {
  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(db.doc(notificationPath(familyId, notificationId)));
    if (!snap.exists) return { blocked: 'notification_missing' } as const;
    const notification = snap.data() as NotificationDoc;
    const blocked =
      (await readRoutingBlock(tx, db, familyId, notification.childId)) ??
      (notification.status === 'failed' ? 'notification_suppressed' : undefined);
    if (blocked) {
      redactNotification(tx, snap);
      return { blocked } as const;
    }
    return { notification } as const;
  });
  // Throw only after commit, otherwise the redaction would roll back.
  if (result.blocked) throw new SkipEvent(result.blocked);
  return result.notification!;
}
