import type { ConsentReq } from '@ijime/api-types';
import { consent } from '@ijime/config';
import { GoogleAuth } from 'google-auth-library';

import type { VerifiedIdentity } from './auth.js';
import type { AccountTokenIssuer } from './routes/accounts.js';

const IDENTITY_TOOLKIT = 'https://identitytoolkit.googleapis.com';
const IAM_CREDENTIALS = 'https://iamcredentials.googleapis.com';
const CUSTOM_TOKEN_AUDIENCE = `${IDENTITY_TOOLKIT}/google.identity.identitytoolkit.v1.IdentityToolkit`;
const CUSTOM_TOKEN_TTL_SECONDS = 3600;
const REQUEST_TIMEOUT_MS = 10_000;

export type IssuerTransport = {
  // 呼び出し元（実行 ID）のサービスアカウントのメールアドレス。カスタムトークンの iss と sub に使う
  serviceAccountEmail(): Promise<string>;
  // 実行 ID の認証情報を付けた POST。2xx 以外ではエラーを投げ、エラーにリクエスト本文を含めない
  post(url: string, body: unknown): Promise<unknown>;
};

export function adcTransport(): IssuerTransport {
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  let email: Promise<string> | undefined;
  return {
    serviceAccountEmail() {
      email ??= auth.getCredentials().then((credentials) => {
        if (!credentials.client_email) throw new Error('service_account_required');
        return credentials.client_email;
      });
      email.catch(() => {
        email = undefined;
      });
      return email;
    },
    async post(url, body) {
      // 失敗時は固定のエラー名だけを返す：レスポンス本文とリクエスト本文にはクレームや署名前のトークン内容が含まれるため、上位へ渡さない
      let res: Response;
      try {
        const token = await auth.getAccessToken();
        if (!token) throw new Error('no_access_token');
        res = await fetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch {
        throw new Error('issuer_request_failed');
      }
      if (!res.ok) throw new Error('issuer_request_failed');
      return res.json().catch(() => {
        throw new Error('issuer_request_failed');
      });
    },
  };
}

// 本番環境のアカウント発行器（docs/04-backend-api.md「認証と権限」）：
// 保護者のロールは Identity Platform のカスタムクレームに書き込む。子どもはペアリングコードと引き換えに、実行 ID が署名したカスタムトークンを受け取る。
export function identityPlatformIssuer(
  projectId: string,
  transport: IssuerTransport = adcTransport(),
  now: () => Date = () => new Date(),
): AccountTokenIssuer {
  return {
    developmentOnly: false,
    async setGuardianClaims(uid, claims) {
      await transport.post(`${IDENTITY_TOOLKIT}/v1/projects/${projectId}/accounts:update`, {
        localId: uid,
        customAttributes: JSON.stringify(claims),
      });
    },
    async issueChildToken(claims) {
      const email = await transport.serviceAccountEmail();
      const issuedAt = Math.floor(now().getTime() / 1000);
      const data = (await transport.post(
        `${IAM_CREDENTIALS}/v1/projects/-/serviceAccounts/${encodeURIComponent(email)}:signJwt`,
        {
          payload: JSON.stringify({
            iss: email,
            sub: email,
            aud: CUSTOM_TOKEN_AUDIENCE,
            iat: issuedAt,
            exp: issuedAt + CUSTOM_TOKEN_TTL_SECONDS,
            uid: claims.childId,
            claims,
          }),
        },
      )) as { signedJwt?: unknown } | undefined;
      if (typeof data?.signedJwt !== 'string' || !data.signedJwt)
        throw new Error('issuer_request_failed');
      return data.signedJwt;
    },
  };
}

export const CONSENT_METHOD = 'email_reauth_attestation_v1';
export const GUARDIAN_ATTESTATION = 'legal_guardian_adult';

// 保護者の同意の検証：確認済みのメールアドレス + 署名の直前に再ログイン済み + 明示的な宣言
// 「18 歳以上で、子どもの法定代理人である」。1つでも満たさなければエラーを投げ、ルート側で一律に PERMISSION_DENIED を返す。
export function emailReauthConsentVerifier(now: () => Date = () => new Date()) {
  return async (identity: VerifiedIdentity, request: ConsentReq): Promise<{ method: string }> => {
    if (!identity.email || identity.email_verified !== true) throw new Error('email_unverified');
    const age = now().getTime() / 1000 - (identity.auth_time ?? 0);
    if (!identity.auth_time || age < 0 || age > consent.reauthMaxAgeSeconds)
      throw new Error('reauthentication_required');
    if (request.verification?.['guardianAttestation'] !== GUARDIAN_ATTESTATION)
      throw new Error('attestation_required');
    return { method: CONSENT_METHOD };
  };
}
