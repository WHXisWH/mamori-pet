import { FieldValue } from '@google-cloud/firestore';
import type { DeletionRes } from '@ijime/api-types';
import { ApiHttpError, stableId, type ServiceApp, type ServiceEnv } from '@ijime/service-kit';
import type { Hono } from 'hono';

import { childAuth, guardianAuth, type AuthEnv, type GuardianAuthEnv } from '../auth.js';
import type { ChatDeps } from '../chat.js';
import { familyOfGuardian } from './notifications.js';

export type DeletionDeps = Pick<ChatDeps, 'db' | 'auth' | 'publish'>;

export function registerDeletion(app: ServiceApp, getDeps: () => Promise<DeletionDeps>): void {
  const r = (app as unknown as Hono<AuthEnv & ServiceEnv>).basePath('/v1/child');
  r.use('/data-deletion-requests', async (c, next) => childAuth((await getDeps()).auth)(c, next));
  r.post('/data-deletion-requests', async (c) => {
    const deps = await getDeps();
    const { childId } = c.get('child');
    const result = await acceptChildDeletion(deps, childId, childId, 'child');
    return c.json({ requestId: result.requestId, status: 'accepted' } satisfies DeletionRes, 202);
  });
}

export function registerGuardianDeletion(
  app: ServiceApp,
  getDeps: () => Promise<DeletionDeps>,
): void {
  const r = app as unknown as Hono<GuardianAuthEnv & ServiceEnv>;
  const path = '/v1/children/:childId/data-deletion-requests';
  r.use(path, async (c, next) => {
    const deps = await getDeps();
    return guardianAuth(deps.auth, (id) => familyOfGuardian(deps.db, id))(c, next);
  });
  r.post(path, async (c) => {
    const deps = await getDeps();
    const { familyId, guardianId } = c.get('guardian');
    const result = await acceptChildDeletion(
      deps,
      c.req.param('childId'),
      guardianId,
      'guardian',
      familyId,
    );
    return c.json({ requestId: result.requestId, status: 'accepted' } satisfies DeletionRes, 202);
  });
}

async function acceptChildDeletion(
  deps: DeletionDeps,
  childId: string,
  requestedBy: string,
  requesterRole: 'child' | 'guardian',
  expectedFamilyId?: string,
): Promise<{ requestId: string }> {
  // Locate by the authenticated claim, also after directory.lookup starts rejecting deleting children.
  const children = await deps.db
    .collectionGroup('children')
    .where('childId', '==', childId)
    .limit(1)
    .get();
  const child = children.docs[0];
  if (!child) throw new ApiHttpError('NOT_FOUND', 'unknown child');
  const familyId = child.ref.parent.parent!.id;
  if (expectedFamilyId && expectedFamilyId !== familyId)
    throw new ApiHttpError('NOT_FOUND', 'unknown child');
  const requestId = `delete-${stableId(familyId, childId)}`;
  const request = deps.db.doc(`deletionRequests/${requestId}`);
  const progress = await deps.db.runTransaction(async (tx) => {
    const [existing, owner] = await tx.getAll(request, child.ref);
    if (requesterRole === 'guardian') {
      const member = await tx.get(deps.db.doc(`families/${familyId}/guardians/${requestedBy}`));
      if (
        !member.exists ||
        member.get('guardianId') !== requestedBy ||
        member.get('role') !== 'primary' ||
        member.get('revokedAt') != null ||
        (member.get('status') !== undefined && member.get('status') !== 'active')
      )
        throw new ApiHttpError('PERMISSION_DENIED', 'primary guardian required');
    }
    if (!owner?.exists || (owner.get('status') !== 'active' && owner.get('status') !== 'deleting'))
      throw new ApiHttpError('NOT_FOUND', 'unknown child');
    if (!existing!.exists) {
      tx.create(request, {
        familyId,
        childId,
        requestedBy,
        requesterRole,
        status: 'accepted',
        requestedAt: new Date(),
      });
      tx.update(child.ref, {
        status: 'deleting',
        deletionRequestId: requestId,
        agentSummary: FieldValue.delete(),
        memoryRevision: FieldValue.increment(1),
      });
    }
    const completed = existing!.get('status') === 'completed';
    return {
      cleared: completed || existing!.get('firestoreClearedAt') != null,
      published: completed || existing!.get('deletionEventPublishedAt') != null,
    };
  });
  // Resume unfinished steps after a failure; acceptance alone does not mean cleanup succeeded.
  if (!progress.cleared) {
    // Keep the root tombstone: a local directory must never recreate a deleted identity.
    for (const collection of await child.ref.listCollections())
      await deps.db.recursiveDelete(collection);
    const notifications = await deps.db
      .collection(`families/${familyId}/notifications`)
      .where('childId', '==', childId)
      .get();
    for (const notification of notifications.docs) await deps.db.recursiveDelete(notification.ref);
    await request.update({ firestoreClearedAt: new Date() });
  }
  // External storage / de-identified warehouse / backups need the deletion worker.
  // Deliberately do not mark the request completed merely because Firestore is empty.
  if (!progress.published) {
    await deps.publish('data.deletion_requested', { familyId, childId, scope: 'child' });
    await request.update({ deletionEventPublishedAt: new Date() });
  }
  return { requestId };
}
