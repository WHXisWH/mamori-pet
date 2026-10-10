import { createHash, randomBytes } from 'node:crypto';

import type { DocumentSnapshot } from '@google-cloud/firestore';
import type { AcceptInviteRes, InviteRes } from '@ijime/api-types';
import { limits, retention } from '@ijime/config';
import { ApiHttpError, type ServiceApp } from '@ijime/service-kit';
import { z } from 'zod';

import { accountIdentity } from '../auth.js';
import { activeFamily, issuerFor, unavailable, type AccountDeps } from './accounts.js';
import { familyOfGuardian } from './notifications.js';
import { storedDate } from './workflow-store.js';

// 第二保護者の招待（docs/03-database.md invitations、docs/04-backend-api.md「保護者側 API」）。
// 招待 ID は 128 ビットの乱数トークンで、DB にはそのハッシュだけを保存する。受諾時はログイン中のメールアドレスが招待先と一致することも求める
const TOKEN = /^[A-Za-z0-9_-]{22}$/;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const inviteSchema = z.strictObject({ email: z.email().max(254) });

function activeMember(doc: DocumentSnapshot): boolean {
  const status = doc.get('status');
  return doc.get('revokedAt') == null && (status === undefined || status === 'active');
}

function hasSecondary(docs: readonly DocumentSnapshot[]): boolean {
  return docs.some((d) => d.get('role') === 'secondary' && activeMember(d));
}

export function registerInvitations(app: ServiceApp, getDeps: () => Promise<AccountDeps>) {
  for (const path of ['/v1/guardians/invitations', '/v1/guardians/invitations/*'])
    app.use(path, async (c, next) => {
      c.header('Cache-Control', 'no-store');
      await next();
    });

  app.post('/v1/guardians/invitations', async (c) => {
    const deps = await getDeps();
    const identity = await accountIdentity(c.req.raw.headers, deps.auth);
    const parsed = inviteSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      throw new ApiHttpError('INVALID_ARGUMENT', 'メールアドレスを確認してください');
    const email = parsed.data.email.toLowerCase();
    const familyId = await familyOfGuardian(deps.db, identity.sub);
    if (!familyId) throw new ApiHttpError('NOT_FOUND', '家族を登録してください');
    const token = randomBytes(16).toString('base64url');
    const id = hash(token);
    const now = deps.now();
    const expiresAt = new Date(now.getTime() + retention.invitationDays * 86_400_000);
    await deps.db.runTransaction(async (tx) => {
      const family = await activeFamily(deps, tx, familyId);
      const me = await tx.get(deps.db.doc(`families/${familyId}/guardians/${identity.sub}`));
      if (
        me.get('role') !== 'primary' ||
        family.get('primaryGuardianId') !== identity.sub ||
        !activeMember(me)
      )
        throw new ApiHttpError('PERMISSION_DENIED', '主保護者だけが招待できます');
      if (String(me.get('email') ?? '').toLowerCase() === email)
        throw new ApiHttpError('INVALID_ARGUMENT', 'ご自身以外のメールアドレスを入力してください');
      const guardians = await tx.get(deps.db.collection(`families/${familyId}/guardians`));
      if (hasSecondary(guardians.docs))
        throw new ApiHttpError('ALREADY_EXISTS', 'すでに第二保護者が登録されています');
      const invitations = await tx.get(deps.db.collection(`families/${familyId}/invitations`));
      const pending = invitations.docs.filter(
        (d) =>
          !d.get('acceptedAt') &&
          !d.get('revokedAt') &&
          (storedDate(d.get('expiresAt'))?.getTime() ?? 0) > now.getTime(),
      );
      if (pending.length >= limits.pendingInvitationsPerFamily)
        throw new ApiHttpError('RATE_LIMITED', '有効な招待が多すぎます。期限切れを待ってください');
      tx.create(deps.db.doc(`families/${familyId}/invitations/${id}`), {
        email,
        invitedBy: identity.sub,
        expiresAt,
        createdAt: now,
      });
      tx.create(deps.db.doc(`invitationLookup/${id}`), { familyId, expiresAt });
    });
    const body: InviteRes = { invitationId: token, expiresAt: expiresAt.toISOString() };
    return c.json(body, 201);
  });

  app.post('/v1/guardians/invitations/:invitationId/accept', async (c) => {
    const deps = await getDeps();
    const identity = await accountIdentity(c.req.raw.headers, deps.auth);
    const token = c.req.param('invitationId');
    if (!TOKEN.test(token)) throw new ApiHttpError('NOT_FOUND', '招待が見つかりません');
    if (!identity.development && (!identity.email || identity.email_verified !== true))
      throw new ApiHttpError('PERMISSION_DENIED', 'メールアドレスの確認が必要です');
    const issuer = issuerFor(deps);
    const id = hash(token);
    const lookupRef = deps.db.doc(`invitationLookup/${id}`);
    const familyId = await deps.db.runTransaction(async (tx) => {
      const lookup = await tx.get(lookupRef);
      if (!lookup.exists) throw new ApiHttpError('NOT_FOUND', '招待が見つかりません');
      const familyId = String(lookup.get('familyId'));
      const invitation = await tx.get(deps.db.doc(`families/${familyId}/invitations/${id}`));
      if (!invitation.exists) throw new ApiHttpError('NOT_FOUND', '招待が見つかりません');
      const membership = await tx.get(
        deps.db.collectionGroup('guardians').where('guardianId', '==', identity.sub).limit(1),
      );
      // 同じ人が再試行したとき（カスタムクレームの設定に失敗した後など）は成功として返す
      if (invitation.get('acceptedBy') === identity.sub) return familyId;
      if (
        invitation.get('acceptedAt') ||
        invitation.get('revokedAt') ||
        (storedDate(invitation.get('expiresAt'))?.getTime() ?? 0) <= deps.now().getTime()
      )
        throw new ApiHttpError('INVITATION_EXPIRED', '招待の期限が切れています');
      if (
        !identity.development &&
        String(invitation.get('email')) !== (identity.email ?? '').toLowerCase()
      )
        throw new ApiHttpError('PERMISSION_DENIED', 'このメールアドレス宛ての招待ではありません');
      if (!membership.empty)
        throw new ApiHttpError('ALREADY_EXISTS', 'すでに家族に登録されています');
      await activeFamily(deps, tx, familyId);
      const guardians = await tx.get(deps.db.collection(`families/${familyId}/guardians`));
      if (hasSecondary(guardians.docs))
        throw new ApiHttpError('ALREADY_EXISTS', 'すでに第二保護者が登録されています');
      const now = deps.now();
      tx.create(deps.db.doc(`families/${familyId}/guardians/${identity.sub}`), {
        guardianId: identity.sub,
        role: 'secondary',
        email: identity.email || String(invitation.get('email')),
        notifyChannels: identity.development ? ['webpush'] : ['webpush', 'email'],
        invitedBy: invitation.get('invitedBy'),
        createdAt: now,
      });
      tx.update(invitation.ref, { acceptedAt: now, acceptedBy: identity.sub });
      tx.update(lookupRef, { usedAt: now });
      return familyId;
    });
    try {
      await issuer.setGuardianClaims(identity.sub, {
        role: 'guardian',
        familyId,
        guardianRole: 'secondary',
      });
    } catch {
      throw unavailable();
    }
    const body: AcceptInviteRes = { familyId };
    return c.json(body);
  });
}
