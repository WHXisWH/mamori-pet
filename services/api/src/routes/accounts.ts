import { createHash, randomInt, randomUUID } from 'node:crypto';

import { FieldValue, type Firestore, type Transaction } from '@google-cloud/firestore';
import {
  DATA_SOURCES,
  GRADE_BANDS,
  type ConsentReq,
  type ConsentsRes,
  type GradeBand,
  type MeRes,
  type PairRes,
  type PairingCodeRes,
} from '@ijime/api-types';
import { limits, retention } from '@ijime/config';
import type { EnvelopeCipher, Pseudonymizer } from '@ijime/crypto';
import { ApiHttpError, type ServiceApp } from '@ijime/service-kit';
import { z } from 'zod';

import { accountIdentity, type AuthOptions, type VerifiedIdentity } from '../auth.js';
import { takePairingSlot } from '../pairing-limiter.js';
import { familyOfGuardian } from './notifications.js';
import { resourceId, storedDate } from './workflow-store.js';

type ChildClaims = { role: 'child'; familyId: string; childId: string; gradeBand: GradeBand };
export type AccountTokenIssuer = {
  developmentOnly: boolean;
  setGuardianClaims(
    uid: string,
    claims: { role: 'guardian'; familyId: string; guardianRole: 'primary' | 'secondary' },
  ): Promise<void>;
  issueChildToken(claims: ChildClaims): Promise<string>;
};
export type AccountDeps = {
  db: Firestore;
  auth: AuthOptions;
  cipher: EnvelopeCipher;
  pseudonymizer: Pseudonymizer;
  issuer?: AccountTokenIssuer | undefined;
  verifyConsent?:
    ((identity: VerifiedIdentity, request: ConsentReq) => Promise<{ method: string }>) | undefined;
  now: () => Date;
};
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const consentSchema = z.strictObject({
  type: z.enum(['guardian_terms', 'guardian_sensitive']),
  documentVersion: z.string().trim().min(1).max(100),
  subjectChildId: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,128}$/)
    .optional(),
  scope: z.record(z.string().max(100), z.boolean()).optional(),
  verification: z.record(z.string().max(100), z.string().max(1000)).optional(),
});
const noSources = Object.fromEntries(DATA_SOURCES.map((source) => [source, false]));
export const unavailable = () =>
  new ApiHttpError('MODEL_UNAVAILABLE', 'アカウント連携が設定されていません');
export function issuerFor(deps: AccountDeps) {
  const issuer = deps.issuer;
  if (
    !issuer ||
    (issuer.developmentOnly &&
      (!deps.auth.allowDevHeader || process.env['NODE_ENV'] === 'production'))
  )
    throw unavailable();
  return issuer;
}

export async function activeFamily(
  deps: AccountDeps,
  tx: Transaction,
  familyId: string,
  needsConsent = true,
) {
  const family = await tx.get(deps.db.doc(`families/${familyId}`));
  if (!family.exists || family.get('status') !== 'active')
    throw new ApiHttpError('PERMISSION_DENIED', '家族を利用できません');
  if (
    family.get('developmentOnly') &&
    (!deps.auth.allowDevHeader || process.env['NODE_ENV'] === 'production')
  )
    throw new ApiHttpError('PERMISSION_DENIED', 'ローカル専用の家族です');
  if (needsConsent && family.get('consentComplete') !== true)
    throw new ApiHttpError('CONSENT_REQUIRED', '保護者の同意が必要です');
  return family;
}

export function registerAccounts(app: ServiceApp, getDeps: () => Promise<AccountDeps>) {
  const owner = async (headers: Headers) => {
    const deps = await getDeps();
    const identity = await accountIdentity(headers, deps.auth);
    const familyId = await familyOfGuardian(deps.db, identity.sub);
    if (!familyId) throw new ApiHttpError('NOT_FOUND', '家族を登録してください');
    const member = await deps.db.doc(`families/${familyId}/guardians/${identity.sub}`).get();
    if (
      !['primary', 'secondary'].includes(member.get('role')) ||
      member.get('revokedAt') ||
      (member.get('status') && member.get('status') !== 'active')
    )
      throw new ApiHttpError('PERMISSION_DENIED', '家族を利用できません');
    return { deps, identity, familyId };
  };
  for (const path of [
    '/v1/me',
    '/v1/families',
    '/v1/consents',
    '/v1/consents/*',
    '/v1/children',
    '/v1/children/*/pairing-codes',
    '/v1/child/pair',
  ])
    app.use(path, async (c, next) => {
      c.header('Cache-Control', 'no-store');
      await next();
    });

  app.post('/v1/families', async (c) => {
    const deps = await getDeps();
    const identity = await accountIdentity(c.req.raw.headers, deps.auth);
    const parsed = z
      .strictObject({ displayName: z.string().trim().max(100).optional() })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ApiHttpError('INVALID_ARGUMENT', '登録内容を確認してください');
    if (!identity.development && (!identity.email || identity.email_verified !== true))
      throw new ApiHttpError('PERMISSION_DENIED', 'メールアドレスの確認が必要です');
    const issuer = issuerFor(deps);
    const familyId =
      (await familyOfGuardian(deps.db, identity.sub)) ?? `f_${hash(identity.sub).slice(0, 32)}`;
    const ref = deps.db.doc(`families/${familyId}`);
    await deps.db.runTransaction(async (tx) => {
      const family = await tx.get(ref);
      if (family.exists) {
        await activeFamily(deps, tx, familyId, false);
        if (family.get('primaryGuardianId') !== identity.sub)
          throw new ApiHttpError('ALREADY_EXISTS', 'すでに家族に登録されています');
        return;
      }
      const now = deps.now();
      tx.create(ref, {
        familyId,
        primaryGuardianId: identity.sub,
        status: 'active',
        termsVersion: '',
        consentComplete: false,
        developmentOnly: identity.development,
        createdAt: now,
      });
      tx.create(ref.collection('guardians').doc(identity.sub), {
        guardianId: identity.sub,
        role: 'primary',
        email: identity.email ?? '',
        ...(parsed.data.displayName ? { displayName: parsed.data.displayName } : {}),
        notifyChannels: identity.development ? ['webpush'] : ['webpush', 'email'],
        createdAt: now,
      });
    });
    try {
      await issuer.setGuardianClaims(identity.sub, {
        role: 'guardian',
        familyId,
        guardianRole: 'primary',
      });
    } catch {
      throw unavailable();
    }
    return c.json({ familyId }, 201);
  });

  app.get('/v1/me', async (c) => {
    const { deps, identity, familyId } = await owner(c.req.raw.headers);
    const body = await deps.db.runTransaction(
      async (tx): Promise<MeRes> => {
        const family = await activeFamily(deps, tx, familyId, false);
        const guardian = await tx.get(
          deps.db.doc(`families/${familyId}/guardians/${identity.sub}`),
        );
        const children = await tx.get(deps.db.collection(`families/${familyId}/children`));
        return {
          guardian: {
            guardianId: identity.sub,
            role: guardian.get('role') === 'secondary' ? 'secondary' : 'primary',
            email: guardian.get('email') ?? '',
            ...(guardian.get('displayName') ? { displayName: guardian.get('displayName') } : {}),
          },
          family: {
            familyId,
            termsVersion: family.get('termsVersion') ?? '',
            consentComplete: family.get('consentComplete') === true,
          },
          children: children.docs
            .filter((doc) => doc.get('status') !== 'deleting')
            .map((doc) => ({
              childId: doc.id,
              nickname: doc.get('nickname'),
              gradeBand: doc.get('gradeBand'),
              paired: !!doc.get('pairedAt'),
              assentComplete: doc.get('assentComplete') === true,
            })),
        };
      },
      { readOnly: true },
    );
    return c.json(body);
  });

  app.post('/v1/consents', async (c) => {
    const { deps, identity, familyId } = await owner(c.req.raw.headers);
    const parsed = consentSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ApiHttpError('INVALID_ARGUMENT', '同意内容を確認してください');
    const input: ConsentReq = {
      type: parsed.data.type,
      documentVersion: parsed.data.documentVersion,
      ...(parsed.data.subjectChildId ? { subjectChildId: parsed.data.subjectChildId } : {}),
      ...(parsed.data.scope ? { scope: parsed.data.scope } : {}),
      ...(parsed.data.verification ? { verification: parsed.data.verification } : {}),
    };
    const issuer = issuerFor(deps);
    let method: string;
    if (identity.development && issuer.developmentOnly) method = 'local_demo_unverified';
    else {
      if (!deps.verifyConsent) throw unavailable();
      try {
        method = (await deps.verifyConsent(identity, input)).method;
      } catch {
        throw new ApiHttpError('PERMISSION_DENIED', '保護者の確認が完了していません');
      }
      if (!method || method === 'local_demo_unverified') throw unavailable();
    }
    const key = c.req.header('Idempotency-Key');
    const consentId = key ? hash(`${identity.sub}:${resourceId(key)}`) : randomUUID();
    const requestHash = hash(
      JSON.stringify([
        input.type,
        input.documentVersion,
        input.subjectChildId ?? null,
        input.scope ?? {},
      ]),
    );
    const ref = deps.db.doc(`families/${familyId}/consents/${consentId}`);
    const grantedAt = await deps.db.runTransaction(async (tx) => {
      const family = await activeFamily(deps, tx, familyId, false);
      const guardian = await tx.get(deps.db.doc(`families/${familyId}/guardians/${identity.sub}`));
      if (guardian.get('role') !== 'primary')
        throw new ApiHttpError('PERMISSION_DENIED', '主保護者の同意が必要です');
      const existing = await tx.get(ref);
      if (existing.exists) {
        if (existing.get('requestHash') !== requestHash || existing.get('revokedAt'))
          throw new ApiHttpError('ALREADY_EXISTS', 'この同意リクエストは処理済みです');
        return storedDate(existing.get('grantedAt'))!;
      }
      if (input.subjectChildId) {
        const child = await tx.get(
          deps.db.doc(`families/${familyId}/children/${input.subjectChildId}`),
        );
        if (!child.exists || child.get('status') === 'deleting')
          throw new ApiHttpError('NOT_FOUND', '子どもが見つかりません');
      }
      const consents = await tx.get(deps.db.collection(`families/${familyId}/consents`));
      const children = await tx.get(deps.db.collection(`families/${familyId}/children`));
      const active = consents.docs
        .filter((d) => !d.get('revokedAt') && !d.get('subjectChildId'))
        .map((d) => d.get('type'));
      if (!input.subjectChildId) active.push(input.type);
      const complete = active.includes('guardian_terms') && active.includes('guardian_sensitive');
      const now = deps.now();
      tx.create(ref, {
        type: input.type,
        documentVersion: input.documentVersion,
        ...(input.subjectChildId ? { subjectChildId: input.subjectChildId } : {}),
        ...(input.scope ? { scope: input.scope } : {}),
        actorId: identity.sub,
        verificationMethod: method,
        grantedAt: now,
        requestHash,
      });
      tx.update(family.ref, {
        consentComplete: complete,
        ...(input.type === 'guardian_terms' && !input.subjectChildId
          ? { termsVersion: input.documentVersion }
          : {}),
      });
      if (method !== 'local_demo_unverified') tx.update(guardian.ref, { verifiedAt: now });
      if (complete && !input.subjectChildId)
        for (const child of children.docs) {
          if (child.get('status') === 'paused' && child.get('pauseReason') === 'guardian_consent')
            tx.update(child.ref, { status: 'active', pauseReason: FieldValue.delete() });
        }
      return now;
    });
    return c.json({ consentId, grantedAt: grantedAt.toISOString() }, 201);
  });

  app.get('/v1/consents', async (c) => {
    const { deps, familyId } = await owner(c.req.raw.headers);
    const body = await deps.db.runTransaction(
      async (tx): Promise<ConsentsRes> => {
        await activeFamily(deps, tx, familyId, false);
        const records = await tx.get(deps.db.collection(`families/${familyId}/consents`));
        return {
          items: records.docs
            .filter((d) => ['guardian_terms', 'guardian_sensitive'].includes(d.get('type')))
            .map((d) => ({
              consentId: d.id,
              type: d.get('type'),
              documentVersion: d.get('documentVersion'),
              ...(d.get('subjectChildId')
                ? { subjectChildId: d.get('subjectChildId') as string }
                : {}),
              verificationMethod: d.get('verificationMethod') ?? 'unverified',
              grantedAt: storedDate(d.get('grantedAt'))!.toISOString(),
              ...(d.get('revokedAt')
                ? { revokedAt: storedDate(d.get('revokedAt'))!.toISOString() }
                : {}),
            })),
        };
      },
      { readOnly: true },
    );
    return c.json(body);
  });

  app.delete('/v1/consents/:consentId', async (c) => {
    const { deps, identity, familyId } = await owner(c.req.raw.headers);
    const id = resourceId(c.req.param('consentId'));
    await deps.db.runTransaction(async (tx) => {
      const family = await activeFamily(deps, tx, familyId, false);
      const guardian = await tx.get(deps.db.doc(`families/${familyId}/guardians/${identity.sub}`));
      if (guardian.get('role') !== 'primary')
        throw new ApiHttpError('PERMISSION_DENIED', '主保護者の操作が必要です');
      const consents = await tx.get(deps.db.collection(`families/${familyId}/consents`));
      const consent = consents.docs.find((d) => d.id === id);
      if (!consent || consent.get('type') === 'child_assent')
        throw new ApiHttpError('NOT_FOUND', '同意が見つかりません');
      if (consent.get('revokedAt')) return;
      const children = await tx.get(deps.db.collection(`families/${familyId}/children`));
      const active = consents.docs
        .filter((d) => d.id !== id && !d.get('revokedAt') && !d.get('subjectChildId'))
        .map((d) => d.get('type'));
      const complete = active.includes('guardian_terms') && active.includes('guardian_sensitive');
      tx.update(consent.ref, { revokedAt: deps.now() });
      tx.update(family.ref, { consentComplete: complete });
      for (const child of children.docs) {
        if (child.get('status') === 'deleting') continue;
        if (!complete || consent.get('subjectChildId') === child.id)
          tx.update(child.ref, {
            status: 'paused',
            pauseReason: 'guardian_consent',
            assentComplete: false,
            dataSources: noSources,
            memoryRevision: FieldValue.increment(1),
          });
      }
    });
    return c.body(null, 204);
  });

  app.post('/v1/children', async (c) => {
    const { deps, identity, familyId } = await owner(c.req.raw.headers);
    const parsed = z
      .strictObject({
        nickname: z.string().trim().min(limits.nickname.min).max(limits.nickname.max),
        gradeBand: z.enum(GRADE_BANDS),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      throw new ApiHttpError('INVALID_ARGUMENT', 'ニックネームと学年を確認してください');
    const key = c.req.header('Idempotency-Key');
    const childId = key
      ? hash(`${familyId}:${identity.sub}:${resourceId(key)}`).slice(0, 32)
      : randomUUID();
    const ref = deps.db.doc(`families/${familyId}/children/${childId}`);
    const requestHash = hash(JSON.stringify(parsed.data));
    const { wrappedDek } = await deps.cipher.newChildKey(childId);
    const pseudoId = await deps.pseudonymizer.pseudonymize(childId);
    await deps.db.runTransaction(async (tx) => {
      await activeFamily(deps, tx, familyId);
      const guardian = await tx.get(deps.db.doc(`families/${familyId}/guardians/${identity.sub}`));
      if (guardian.get('role') !== 'primary')
        throw new ApiHttpError('PERMISSION_DENIED', '主保護者の操作が必要です');
      const old = await tx.get(ref);
      if (old.exists) {
        if (old.get('requestHash') !== requestHash || old.get('status') !== 'active')
          throw new ApiHttpError('ALREADY_EXISTS', 'この登録は処理済みです');
        return;
      }
      const siblings = await tx.get(deps.db.collection(`families/${familyId}/children`));
      if (
        siblings.docs.filter((d) => d.get('status') !== 'deleting').length >=
        limits.childrenPerFamily
      )
        throw new ApiHttpError('RATE_LIMITED', '登録できるお子さんの人数の上限に達しています');
      tx.create(ref, {
        childId,
        familyId,
        ...parsed.data,
        requestHash,
        wrappedDek,
        pseudoId,
        dataSources: noSources,
        careFlag: false,
        deviceLockEnabled: false,
        status: 'active',
        assentComplete: false,
        requiresGuardianConsent: true,
        createdAt: deps.now(),
      });
    });
    return c.json({ childId }, 201);
  });

  app.post('/v1/children/:childId/pairing-codes', async (c) => {
    const { deps, familyId, identity } = await owner(c.req.raw.headers);
    const issuer = issuerFor(deps);
    const childId = resourceId(c.req.param('childId'));
    const childRef = deps.db.doc(`families/${familyId}/children/${childId}`);
    for (let attempt = 0; attempt < 10; attempt++) {
      const code = String(randomInt(10 ** limits.pairingCodeDigits)).padStart(
        limits.pairingCodeDigits,
        '0',
      );
      if (code === '123456') continue;
      const codeHash = hash(code);
      const lookup = deps.db.doc(`pairingCodeLookup/${codeHash}`);
      const expiresAt = new Date(deps.now().getTime() + retention.pairingCodeMinutes * 60_000);
      const saved = await deps.db.runTransaction(async (tx) => {
        await activeFamily(deps, tx, familyId);
        const guardian = await tx.get(
          deps.db.doc(`families/${familyId}/guardians/${identity.sub}`),
        );
        if (
          !['primary', 'secondary'].includes(guardian.get('role')) ||
          guardian.get('revokedAt') ||
          (guardian.get('status') && guardian.get('status') !== 'active')
        )
          throw new ApiHttpError('PERMISSION_DENIED', '家族を利用できません');
        if (
          !(identity.development && issuer.developmentOnly) &&
          !storedDate(guardian.get('verifiedAt'))
        )
          throw new ApiHttpError('CONSENT_REQUIRED', '保護者の確認が必要です');
        const child = await tx.get(childRef);
        const existing = await tx.get(lookup);
        if (!child.exists) throw new ApiHttpError('NOT_FOUND', '子どもが見つかりません');
        if (child.get('status') !== 'active')
          throw new ApiHttpError('CONSENT_REQUIRED', '子どもの利用が停止されています');
        if (
          existing.exists &&
          (storedDate(existing.get('expiresAt'))?.getTime() ?? 0) > deps.now().getTime()
        )
          return false;
        const record = { childId, familyId, createdBy: identity.sub, expiresAt };
        tx.set(lookup, record);
        tx.set(deps.db.doc(`families/${familyId}/pairingCodes/${codeHash}`), record);
        tx.update(childRef, { pairingCodeHash: codeHash });
        return true;
      });
      if (saved)
        return c.json(
          { code, qrPayload: code, expiresAt: expiresAt.toISOString() } satisfies PairingCodeRes,
          201,
        );
    }
    throw new ApiHttpError('RATE_LIMITED', '少し待ってから再発行してください');
  });

  app.post('/v1/child/pair', async (c) => {
    const deps = await getDeps();
    const parsed = z
      .strictObject({ code: z.string().regex(/^\d{6}$/) })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ApiHttpError('INVALID_ARGUMENT', '6桁の番号を入力してください');
    const issuer = issuerFor(deps);
    if (!(await takePairingSlot(deps.db, deps.now())))
      throw new ApiHttpError('RATE_LIMITED', '少し待ってから試してください');
    const codeHash = hash(parsed.data.code);
    const lookup = deps.db.doc(`pairingCodeLookup/${codeHash}`);
    const claims = await deps.db.runTransaction(async (tx): Promise<ChildClaims> => {
      const saved = await tx.get(lookup);
      if (
        !saved.exists ||
        saved.get('usedAt') ||
        (storedDate(saved.get('expiresAt'))?.getTime() ?? 0) <= deps.now().getTime()
      )
        throw new ApiHttpError('PAIRING_CODE_EXPIRED', '番号の期限が切れています');
      const familyId = saved.get('familyId') as string;
      const childId = saved.get('childId') as string;
      await activeFamily(deps, tx, familyId);
      const child = await tx.get(deps.db.doc(`families/${familyId}/children/${childId}`));
      if (child.get('status') !== 'active')
        throw new ApiHttpError('CONSENT_REQUIRED', '保護者の確認が必要です');
      if (child.get('pairingCodeHash') !== codeHash)
        throw new ApiHttpError('PAIRING_CODE_EXPIRED', '新しい番号を使ってください');
      tx.update(lookup, { usedAt: deps.now() });
      tx.update(deps.db.doc(`families/${familyId}/pairingCodes/${codeHash}`), {
        usedAt: deps.now(),
      });
      return { role: 'child', familyId, childId, gradeBand: child.get('gradeBand') as GradeBand };
    });
    let customToken: string;
    try {
      customToken = await issuer.issueChildToken(claims);
      if (!customToken) throw unavailable();
    } catch {
      throw unavailable();
    }
    const needsAssent = await deps.db.runTransaction(async (tx) => {
      await activeFamily(deps, tx, claims.familyId);
      const child = await tx.get(
        deps.db.doc(`families/${claims.familyId}/children/${claims.childId}`),
      );
      if (child.get('status') !== 'active')
        throw new ApiHttpError('CONSENT_REQUIRED', '保護者の確認が必要です');
      tx.update(child.ref, { pairedAt: deps.now() });
      return child.get('assentComplete') !== true;
    });
    return c.json({ customToken, childId: claims.childId, needsAssent } satisfies PairRes);
  });
}
