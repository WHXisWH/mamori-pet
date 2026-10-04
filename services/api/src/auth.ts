import type { MiddlewareHandler } from 'hono';
import { OAuth2Client } from 'google-auth-library';
import { ApiHttpError, type Logger } from '@ijime/service-kit';

export const DEV_CHILD_HEADER = 'X-Dev-Child-Id';
export const DEV_GUARDIAN_HEADER = 'X-Dev-Guardian-Id';

export type ChildPrincipal = { role: 'child'; childId: string };
export type GuardianPrincipal = { role: 'guardian'; guardianId: string; familyId: string };

export type AuthEnv = {
  Variables: {
    child: ChildPrincipal;
    requestId: string;
    logger: Logger;
  };
};

export type GuardianAuthEnv = {
  Variables: {
    guardian: GuardianPrincipal;
    requestId: string;
    logger: Logger;
  };
};

export type VerifiedIdentity = {
  sub: string;
  role?: string;
  childId?: string;
  email?: string;
  email_verified?: boolean;
  // 直近に実際にログインした（認証情報を入力した）時刻（秒）。トークンの更新では変わらない
  auth_time?: number;
};

export type AuthOptions = {
  allowDevHeader: boolean;
  projectId?: string;
  verifyIdToken?: (token: string) => Promise<VerifiedIdentity>;
};

const DEV_ID = /^[a-zA-Z0-9_-]{1,64}$/;

const CERT_URL =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

// Firebase ID tokens use securetoken certificates, not Google Sign-In certificates.
// Verification failures are deliberately replaced: SDK errors can contain the JWT.
export function firebaseTokenVerifier(projectId: string, fetchImpl: typeof fetch = fetch) {
  const client = new OAuth2Client();
  let cache: { certs: Record<string, string>; expiresAt: number } | undefined;
  let pending: Promise<Record<string, string>> | undefined;
  const certs = async (): Promise<Record<string, string>> => {
    if (cache && cache.expiresAt > Date.now()) return cache.certs;
    pending ??= (async () => {
      const res = await fetchImpl(CERT_URL, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error('certificate_fetch_failed');
      const data = (await res.json()) as Record<string, unknown>;
      if (
        !data ||
        typeof data !== 'object' ||
        Object.values(data).some((v) => typeof v !== 'string')
      )
        throw new Error('invalid_certificates');
      const seconds = Number(
        /max-age=(\d+)/.exec(res.headers.get('cache-control') ?? '')?.[1] ?? 0,
      );
      cache = {
        certs: data as Record<string, string>,
        expiresAt: Date.now() + Math.min(seconds, 3600) * 1000,
      };
      return cache.certs;
    })().finally(() => {
      pending = undefined;
    });
    return pending;
  };
  return async (token: string): Promise<VerifiedIdentity> => {
    try {
      const header = JSON.parse(Buffer.from(token.split('.')[0] ?? '', 'base64url').toString()) as {
        alg?: string;
        kid?: string;
      };
      if (header.alg !== 'RS256' || !header.kid) throw new Error('invalid_header');
      const ticket = await client.verifySignedJwtWithCertsAsync(token, await certs(), projectId, [
        `https://securetoken.google.com/${projectId}`,
      ]);
      const payload = ticket.getPayload() as
        (VerifiedIdentity & { exp: number; iat: number; auth_time: number }) | undefined;
      const now = Date.now() / 1000;
      if (
        typeof payload?.sub !== 'string' ||
        !payload.sub ||
        payload.sub.length > 128 ||
        typeof payload.exp !== 'number' ||
        payload.exp <= now ||
        typeof payload.iat !== 'number' ||
        payload.iat > now ||
        typeof payload.auth_time !== 'number' ||
        payload.auth_time <= 0 ||
        payload.auth_time > now
      )
        throw new Error('invalid_claims');
      return payload;
    } catch {
      throw new ApiHttpError('UNAUTHENTICATED', 'ログインを確認できません');
    }
  };
}

const verifiers = new Map<string, ReturnType<typeof firebaseTokenVerifier>>();

export async function accountIdentity(headers: Headers, opts: AuthOptions) {
  const bearer = headers.get('Authorization');
  if (bearer) {
    const identity = await bearerIdentity(bearer, opts);
    if (
      !identity.sub ||
      identity.sub.includes('/') ||
      identity.sub.length > 128 ||
      (identity.role !== undefined && identity.role !== 'guardian')
    )
      throw new ApiHttpError('PERMISSION_DENIED', '保護者のアカウントが必要です');
    return { ...identity, development: false };
  }
  const dev = headers.get(DEV_GUARDIAN_HEADER);
  if (process.env['NODE_ENV'] !== 'production' && opts.allowDevHeader && dev && DEV_ID.test(dev))
    return { sub: dev, email: '', development: true };
  throw new ApiHttpError('UNAUTHENTICATED', 'ログインが必要です');
}

async function bearerIdentity(header: string, opts: AuthOptions): Promise<VerifiedIdentity> {
  const token = /^Bearer ([^\s]+)$/i.exec(header)?.[1];
  if (!token) throw new ApiHttpError('UNAUTHENTICATED', 'ログインを確認できません');
  try {
    if (opts.verifyIdToken) return await opts.verifyIdToken(token);
    const projectId =
      opts.projectId ?? process.env['GCP_PROJECT_ID'] ?? process.env['GOOGLE_CLOUD_PROJECT'];
    if (!projectId) throw new Error('auth_project_not_configured');
    let verify = verifiers.get(projectId);
    if (!verify) {
      verify = firebaseTokenVerifier(projectId);
      verifiers.set(projectId, verify);
    }
    return await verify(token);
  } catch {
    throw new ApiHttpError('UNAUTHENTICATED', 'ログインを確認できません');
  }
}

export function childAuth(opts: AuthOptions): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const bearer = c.req.header('Authorization');
    if (bearer) {
      const identity = await bearerIdentity(bearer, opts);
      if (identity.role !== 'child' || !identity.childId || !DEV_ID.test(identity.childId))
        throw new ApiHttpError('PERMISSION_DENIED', '子どものアカウントが必要です');
      c.set('child', { role: 'child', childId: identity.childId });
      await next();
      return;
    }
    const dev = c.req.header(DEV_CHILD_HEADER);
    if (
      process.env['NODE_ENV'] !== 'production' &&
      opts.allowDevHeader &&
      dev &&
      DEV_ID.test(dev)
    ) {
      c.set('child', { role: 'child', childId: dev });
      await next();
      return;
    }
    throw new ApiHttpError('UNAUTHENTICATED', 'ログインが必要です');
  };
}

// 保護者がどの家庭に属するかはサーバー側で調べる。クライアントが送る familyId は信用しない
export function guardianAuth(
  opts: AuthOptions,
  familyOf: (guardianId: string) => Promise<string | undefined>,
): MiddlewareHandler<GuardianAuthEnv> {
  return async (c, next) => {
    const bearer = c.req.header('Authorization');
    if (bearer) {
      const identity = await bearerIdentity(bearer, opts);
      if (identity.role !== 'guardian')
        throw new ApiHttpError('PERMISSION_DENIED', '保護者のアカウントが必要です');
      const familyId = await familyOf(identity.sub);
      if (!familyId) throw new ApiHttpError('PERMISSION_DENIED', '家族が見つかりません');
      c.set('guardian', { role: 'guardian', guardianId: identity.sub, familyId });
      await next();
      return;
    }
    const dev = c.req.header(DEV_GUARDIAN_HEADER);
    if (
      process.env['NODE_ENV'] !== 'production' &&
      opts.allowDevHeader &&
      dev &&
      DEV_ID.test(dev)
    ) {
      const familyId = await familyOf(dev);
      if (!familyId) throw new ApiHttpError('PERMISSION_DENIED', '家族が見つかりません');
      c.set('guardian', { role: 'guardian', guardianId: dev, familyId });
      await next();
      return;
    }
    throw new ApiHttpError('UNAUTHENTICATED', 'ログインが必要です');
  };
}
