import { createHash } from 'node:crypto';

import type { DeviceRes } from '@ijime/api-types';
import { ApiHttpError, type ServiceApp, type ServiceEnv } from '@ijime/service-kit';
import type { Hono } from 'hono';
import { z } from 'zod';

import { childAuth, type AuthEnv } from '../auth.js';
import type { ChatDeps } from '../chat.js';

const deviceSchema = z.strictObject({
  fcmToken: z.string().min(1).max(4096).regex(/^\S+$/),
  platform: z.enum(['ios_pwa', 'android', 'desktop']),
});

export function registerChildDevices(
  app: ServiceApp,
  getDeps: () => Promise<Pick<ChatDeps, 'db' | 'directory' | 'auth'>>,
): void {
  const r = (app as unknown as Hono<AuthEnv & ServiceEnv>).basePath('/v1/child');
  for (const path of ['/devices', '/devices/:deviceId'])
    r.use(path, async (c, next) => {
      c.header('Cache-Control', 'no-store');
      return childAuth((await getDeps()).auth)(c, next);
    });

  r.post('/devices', async (c) => {
    const { db, directory } = await getDeps();
    const { childId } = c.get('child');
    const parsed = deviceSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      throw new ApiHttpError('INVALID_ARGUMENT', '端末の登録内容を確認してください');
    const child = await directory.lookup(childId);
    if (!child) throw new ApiHttpError('NOT_FOUND', 'unknown child');
    const deviceId = createHash('sha256').update(parsed.data.fcmToken).digest('hex');
    const family = db.doc(`families/${child.familyId}`);
    const ref = family.collection('devices').doc(deviceId);
    await db.runTransaction(async (tx) => {
      const familyDoc = await tx.get(family);
      const owner = await tx.get(family.collection('children').doc(childId));
      const existing = await tx.get(
        db.collectionGroup('devices').where('fcmToken', '==', parsed.data.fcmToken),
      );
      if (familyDoc.get('status') !== 'active' || owner.get('status') !== 'active')
        throw new ApiHttpError('PERMISSION_DENIED', '利用できません');
      if (
        existing.docs.some(
          (doc) =>
            doc.ref.path !== ref.path ||
            doc.get('ownerType') !== 'child' ||
            doc.get('ownerId') !== childId,
        )
      )
        throw new ApiHttpError('PERMISSION_DENIED', 'この端末は別のアカウントに登録されています');
      tx.set(ref, {
        ...parsed.data,
        ownerType: 'child',
        ownerId: childId,
        lastSeenAt: new Date(),
      });
    });
    return c.json({ deviceId } satisfies DeviceRes, 201);
  });

  r.delete('/devices/:deviceId', async (c) => {
    const { db } = await getDeps();
    const { childId } = c.get('child');
    const deviceId = c.req.param('deviceId');
    if (!/^[a-f0-9]{64}$/.test(deviceId))
      throw new ApiHttpError('INVALID_ARGUMENT', '端末の登録内容を確認してください');
    const children = await db
      .collectionGroup('children')
      .where('childId', '==', childId)
      .limit(1)
      .get();
    const childRef = children.docs[0]?.ref;
    const family = childRef?.parent.parent;
    if (!childRef || !family) throw new ApiHttpError('NOT_FOUND', 'unknown child');
    await db.runTransaction(async (tx) => {
      const owner = await tx.get(childRef);
      const ref = family.collection('devices').doc(deviceId);
      const device = await tx.get(ref);
      // Revocation remains possible while the child's account is paused or being deleted.
      if (!owner.exists) throw new ApiHttpError('PERMISSION_DENIED', '利用できません');
      if (!device.exists) return;
      if (device.get('ownerType') !== 'child' || device.get('ownerId') !== childId)
        throw new ApiHttpError('PERMISSION_DENIED', 'この端末の登録を変更できません');
      tx.delete(ref);
    });
    return c.body(null, 204);
  });
}
