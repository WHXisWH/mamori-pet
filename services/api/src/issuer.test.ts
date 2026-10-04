import { consent } from '@ijime/config';
import { describe, expect, it } from 'vitest';

import {
  CONSENT_METHOD,
  GUARDIAN_ATTESTATION,
  emailReauthConsentVerifier,
  identityPlatformIssuer,
  type IssuerTransport,
} from './issuer.js';

const NOW = new Date('2026-10-03T12:00:00.000Z');
const SA = 'sa-api@demo-ijime.iam.gserviceaccount.com';

function fakeTransport(response: unknown = {}) {
  const calls: { url: string; body: unknown }[] = [];
  const transport: IssuerTransport = {
    serviceAccountEmail: async () => SA,
    post: async (url, body) => {
      calls.push({ url, body });
      return response;
    },
  };
  return { transport, calls };
}

describe('identityPlatformIssuer', () => {
  it('is not a development issuer', () => {
    expect(identityPlatformIssuer('demo-ijime', fakeTransport().transport).developmentOnly).toBe(
      false,
    );
  });

  it('writes guardian claims as custom attributes of that account only', async () => {
    // Arrange
    const { transport, calls } = fakeTransport();
    const issuer = identityPlatformIssuer('demo-ijime', transport, () => NOW);

    // Act
    await issuer.setGuardianClaims('uid_1', {
      role: 'guardian',
      familyId: 'f_1',
      guardianRole: 'primary',
    });

    // Assert
    expect(calls).toEqual([
      {
        url: 'https://identitytoolkit.googleapis.com/v1/projects/demo-ijime/accounts:update',
        body: {
          localId: 'uid_1',
          customAttributes: '{"role":"guardian","familyId":"f_1","guardianRole":"primary"}',
        },
      },
    ]);
  });

  it('asks the runtime service account to sign a one-hour custom token for the child', async () => {
    // Arrange
    const { transport, calls } = fakeTransport({ signedJwt: 'signed.jwt.value' });
    const issuer = identityPlatformIssuer('demo-ijime', transport, () => NOW);
    const claims = { role: 'child', familyId: 'f_1', childId: 'c_1', gradeBand: 'low' } as const;

    // Act
    const token = await issuer.issueChildToken(claims);

    // Assert
    expect(token).toBe('signed.jwt.value');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(SA)}:signJwt`,
    );
    const issuedAt = NOW.getTime() / 1000;
    expect(JSON.parse((calls[0]!.body as { payload: string }).payload)).toEqual({
      iss: SA,
      sub: SA,
      aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
      iat: issuedAt,
      exp: issuedAt + 3600,
      uid: 'c_1',
      claims,
    });
  });

  it('fails when the signing service returns no token', async () => {
    const issuer = identityPlatformIssuer('demo-ijime', fakeTransport({}).transport, () => NOW);
    await expect(
      issuer.issueChildToken({ role: 'child', familyId: 'f_1', childId: 'c_1', gradeBand: 'low' }),
    ).rejects.toThrow('issuer_request_failed');
  });

  it('propagates transport failures so the route answers 503 instead of pairing', async () => {
    const transport: IssuerTransport = {
      serviceAccountEmail: async () => SA,
      post: async () => {
        throw new Error('issuer_request_failed');
      },
    };
    const issuer = identityPlatformIssuer('demo-ijime', transport, () => NOW);
    await expect(
      issuer.setGuardianClaims('uid_1', {
        role: 'guardian',
        familyId: 'f_1',
        guardianRole: 'primary',
      }),
    ).rejects.toThrow('issuer_request_failed');
  });
});

describe('emailReauthConsentVerifier', () => {
  const verify = emailReauthConsentVerifier(() => NOW);
  const nowSeconds = NOW.getTime() / 1000;
  const identity = {
    sub: 'uid_1',
    email: 'guardian@example.com',
    email_verified: true,
    auth_time: nowSeconds - 60,
  };
  const request = {
    type: 'guardian_terms',
    documentVersion: 'v0.1',
    verification: { guardianAttestation: GUARDIAN_ATTESTATION },
  } as const;

  it('accepts a verified email, a recent sign-in and the guardian attestation', async () => {
    await expect(verify(identity, request)).resolves.toEqual({ method: CONSENT_METHOD });
  });

  it('accepts a sign-in exactly at the allowed age', async () => {
    await expect(
      verify({ ...identity, auth_time: nowSeconds - consent.reauthMaxAgeSeconds }, request),
    ).resolves.toEqual({ method: CONSENT_METHOD });
  });

  it.each([
    ['unverified email', { ...identity, email_verified: false }, request],
    ['missing email', { ...identity, email: '' }, request],
    [
      'stale sign-in',
      { ...identity, auth_time: nowSeconds - consent.reauthMaxAgeSeconds - 1 },
      request,
    ],
    ['missing auth_time', { sub: 'uid_1', email: identity.email, email_verified: true }, request],
    ['auth_time in the future', { ...identity, auth_time: nowSeconds + 30 }, request],
    ['missing attestation', identity, { type: 'guardian_terms', documentVersion: 'v0.1' }],
    ['wrong attestation', identity, { ...request, verification: { guardianAttestation: 'true' } }],
  ] as const)('rejects %s', async (_name, who, what) => {
    await expect(verify(who, what)).rejects.toThrow();
  });
});
