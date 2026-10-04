import { FieldValue } from '@google-cloud/firestore';
import type { DeletionRes } from '@ijime/api-types';
import { ApiHttpError, stableId, type ServiceApp, type ServiceEnv } from '@ijime/service-kit';
import type { Hono } from 'hono';

import { childAuth, type AuthEnv } from '../auth.js';
import type { ChatDeps } from '../chat.js';

export function registerDeletion(app: ServiceApp, getDeps: () => Promise<ChatDeps>): void {
  const r = (app as unknown as Hono<AuthEnv & ServiceEnv>).basePath('/v1/child');
  r.use('/data-deletion-requests', async (c, next) => childAuth((await getDeps()).auth)(c, next));
  r.post('/data-deletion-requests', async (c) => {
    const deps = await getDeps();
    const { childId } = c.get('child');
    // Locate by the authenticated claim, also after directory.lookup starts rejecting deleting children.
    const children = await deps.db
      .collectionGroup('children')
      .where('childId', '==', childId)
      .limit(1)
      .get();
    const child = children.docs[0];
    if (!child) throw new ApiHttpError('NOT_FOUND', 'unknown child');
    const familyId = child.ref.parent.parent!.id;
    const requestId = `delete-${stableId(familyId, childId)}`;
    const request = deps.db.doc(`deletionRequests/${requestId}`);
    await deps.db.runTransaction(async (tx) => {
      const existing = await tx.get(request);
      if (!existing.exists)
        tx.create(request, {
          familyId,
          childId,
          requestedBy: childId,
          requesterRole: 'child',
          status: 'accepted',
          requestedAt: new Date(),
        });
      tx.update(child.ref, {
        status: 'deleting',
        deletionRequestId: requestId,
        agentSummary: FieldValue.delete(),
        memoryRevision: FieldValue.increment(1),
      });
    });
    // Keep the root tombstone: a local directory must never recreate a deleted identity.
    for (const collection of await child.ref.listCollections())
      await deps.db.recursiveDelete(collection);
    const notifications = await deps.db
      .collection(`families/${familyId}/notifications`)
      .where('childId', '==', childId)
      .get();
    for (const notification of notifications.docs) await deps.db.recursiveDelete(notification.ref);
    await request.update({ firestoreClearedAt: new Date() });
    // External storage / de-identified warehouse / backups need the deletion worker.
    // Deliberately do not mark the request completed merely because Firestore is empty.
    await deps.publish('data.deletion_requested', { familyId, childId, scope: 'child' });
    return c.json({ requestId, status: 'accepted' } satisfies DeletionRes, 202);
  });
}
