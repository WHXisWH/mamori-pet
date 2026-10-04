import { createHash } from 'node:crypto';

import { FieldValue, type Firestore, type Transaction } from '@google-cloud/firestore';
import { NOTIFY_CHANNELS, type DeviceRes, type NotifySettingsReq } from '@ijime/api-types';
import { ApiHttpError, type ServiceApp, type ServiceEnv } from '@ijime/service-kit';
import type { Hono } from 'hono';
import { z } from 'zod';

import { guardianAuth, type GuardianAuthEnv, type GuardianPrincipal } from '../auth.js';
import { familyOfGuardian, type NotificationRoutesDeps } from './notifications.js';

const settingsSchema = z
  .strictObject({
    channels: z.array(z.enum(NOTIFY_CHANNELS)).max(10),
    phoneE164: z
      .string()
      .regex(/^\+81[1-9]\d{8,9}$/)
      .optional(),
  })
  .refine((value) => !value.channels.includes('sms') || !!value.phoneE164);
const deviceSchema = z.strictObject({
  fcmToken: z.string().min(1).max(4096).regex(/^\S+$/),
  platform: z.enum(['ios_pwa', 'android', 'desktop']),
});

async function activeGuardian(tx: Transaction, db: Firestore, owner: GuardianPrincipal) {
  const family = await tx.get(db.doc(`families/${owner.familyId}`));
  const guardian = await tx.get(db.doc(`families/${owner.familyId}/guardians/${owner.guardianId}`));
  const role = guardian.get('role');
  const status = guardian.get('status');
  if (
    family.get('status') !== 'active' ||
    !guardian.exists ||
    guardian.get('guardianId') !== owner.guardianId ||
    (role !== 'primary' && role !== 'secondary') ||
    guardian.get('revokedAt') != null ||
    (status !== undefined && status !== 'active')
  )
    throw new ApiHttpError('PERMISSION_DENIED', '保護者の設定を利用できません');
  return guardian;
}

export function registerGuardianSettings(
  app: ServiceApp,
  getDeps: () => Promise<NotificationRoutesDeps>,
): void {
  const r = app as unknown as Hono<GuardianAuthEnv & ServiceEnv>;
  const path = '/v1/guardians/me/notify-settings';
  for (const route of [path, '/v1/devices'])
    r.use(route, async (c, next) => {
      const deps = await getDeps();
      c.header('Cache-Control', 'no-store');
      return guardianAuth(deps.auth, (id) => familyOfGuardian(deps.db, id))(c, next);
    });
  r.get(path, async (c) => {
    const { db } = await getDeps();
    const settings = await db.runTransaction(
      async (tx): Promise<NotifySettingsReq> => {
        const doc = await activeGuardian(tx, db, c.get('guardian'));
        const channels = z
          .array(z.enum(NOTIFY_CHANNELS))
          .parse(doc.get('notifyChannels') ?? ['webpush', 'email']);
        const phone = doc.get('phoneE164');
        return { channels, ...(typeof phone === 'string' ? { phoneE164: phone } : {}) };
      },
      { readOnly: true },
    );
    return c.json(settings);
  });
  r.put(path, async (c) => {
    const { db } = await getDeps();
    const parsed = settingsSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      throw new ApiHttpError(
        'INVALID_ARGUMENT',
        '通知方法と日本の電話番号（+81）を確認してください',
      );
    await db.runTransaction(async (tx) => {
      const guardian = await activeGuardian(tx, db, c.get('guardian'));
      tx.update(guardian.ref, {
        notifyChannels: [...new Set(parsed.data.channels)],
        phoneE164: parsed.data.phoneE164 ?? FieldValue.delete(),
      });
    });
    return c.body(null, 204);
  });
  r.post('/v1/devices', async (c) => {
    const { db } = await getDeps();
    const owner = c.get('guardian');
    const parsed = deviceSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      throw new ApiHttpError('INVALID_ARGUMENT', '端末の登録内容を確認してください');
    const deviceId = createHash('sha256').update(parsed.data.fcmToken).digest('hex');
    const ref = db.doc(`families/${owner.familyId}/devices/${deviceId}`);
    await db.runTransaction(async (tx) => {
      await activeGuardian(tx, db, owner);
      const existing = await tx.get(
        db.collectionGroup('devices').where('fcmToken', '==', parsed.data.fcmToken),
      );
      if (
        existing.docs.some(
          (doc) =>
            doc.ref.parent.parent?.id !== owner.familyId ||
            doc.get('ownerType') !== 'guardian' ||
            doc.get('ownerId') !== owner.guardianId,
        )
      )
        throw new ApiHttpError('PERMISSION_DENIED', 'この端末は別のアカウントに登録されています');
      tx.set(
        ref,
        {
          ...parsed.data,
          ownerType: 'guardian',
          ownerId: owner.guardianId,
          lastSeenAt: new Date(),
        },
        { merge: true },
      );
    });
    const body: DeviceRes = { deviceId };
    return c.json(body, 201);
  });
}
