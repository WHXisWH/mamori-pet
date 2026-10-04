import { generateKeyPairSync, sign } from 'node:crypto';

import { createServiceApp, type ServiceEnv } from '@ijime/service-kit';
import type { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import {
  childAuth,
  firebaseTokenVerifier,
  guardianAuth,
  type AuthEnv,
  type AuthOptions,
  type GuardianAuthEnv,
} from './auth.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const certificate = publicKey.export({ format: 'pem', type: 'spki' }).toString();
const project = 'test-firebase-project';
const now = Math.floor(Date.now() / 1000);
const claims = {
  sub: 'firebase-uid',
  aud: project,
  iss: `https://securetoken.google.com/${project}`,
  iat: now - 10,
  exp: now + 3600,
  auth_time: now - 10,
  role: 'child',
  childId: 'c_verified',
};

function token(overrides: Record<string, unknown> = {}, header: Record<string, unknown> = {}) {
  const encodedHeader = Buffer.from(
    JSON.stringify({ alg: 'RS256', kid: 'key-1', ...header }),
  ).toString('base64url');
  const encodedBody = Buffer.from(JSON.stringify({ ...claims, ...overrides })).toString(
    'base64url',
  );
  const data = `${encodedHeader}.${encodedBody}`;
  return `${data}.${sign('RSA-SHA256', Buffer.from(data), privateKey).toString('base64url')}`;
}

function verifier() {
  const fetcher = vi.fn(
    async (_url: Parameters<typeof fetch>[0]) =>
      new Response(JSON.stringify({ 'key-1': certificate }), {
        headers: { 'cache-control': 'public, max-age=3600' },
      }),
  );
  return { verify: firebaseTokenVerifier(project, fetcher as typeof fetch), fetcher };
}

function testApp(opts: AuthOptions) {
  const app = createServiceApp({ name: 'auth-test', version: 'test' });
  (app as unknown as Hono<AuthEnv & ServiceEnv>).get('/child', childAuth(opts), (c) =>
    c.json(c.get('child')),
  );
  (app as unknown as Hono<GuardianAuthEnv & ServiceEnv>).get(
    '/guardian',
    guardianAuth(opts, async (id) => (id === 'firebase-uid' ? 'server-family' : undefined)),
    (c) => c.json(c.get('guardian')),
  );
  return app;
}

describe('Firebase Bearer verification', () => {
  it('verifies an RSA signed Firebase token and caches the Google certificates', async () => {
    const { verify, fetcher } = verifier();
    expect(await verify(token())).toMatchObject({
      sub: 'firebase-uid',
      role: 'child',
      childId: 'c_verified',
    });
    await verify(token());
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toContain('securetoken@');
  });

  it.each([
    ['expired', { exp: now - 1 }],
    ['wrong project', { aud: 'another-project' }],
    ['Google Sign-In token', { iss: 'https://accounts.google.com' }],
    ['future issued', { iat: now + 1000 }],
    ['missing subject', { sub: '' }],
    ['missing auth time', { auth_time: null }],
  ])('rejects %s without exposing the JWT in its error', async (_name, overrides) => {
    const { verify } = verifier();
    await expect(verify(token(overrides))).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
      message: 'ログインを確認できません',
    });
  });

  it('rejects unsupported algorithms, unknown keys and tampered signatures', async () => {
    const { verify } = verifier();
    await expect(verify(token({}, { alg: 'none' }))).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    await expect(verify(token({}, { kid: 'foreign-key' }))).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    const parts = token().split('.');
    parts[1] = Buffer.from(JSON.stringify({ ...claims, childId: 'victim' })).toString('base64url');
    await expect(verify(parts.join('.'))).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('denies requests when the Google certificate endpoint is unavailable', async () => {
    const verify = firebaseTokenVerifier(
      project,
      vi.fn(async () => new Response('', { status: 503 })) as typeof fetch,
    );
    await expect(verify(token())).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
});

describe('role and identity binding', () => {
  it('uses the signed child claim and ignores conflicting development and query IDs', async () => {
    const { verify } = verifier();
    const app = testApp({ allowDevHeader: false, verifyIdToken: verify });
    const res = await app.request('/child?childId=victim', {
      headers: { Authorization: `Bearer ${token()}`, 'X-Dev-Child-Id': 'victim' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ role: 'child', childId: 'c_verified' });
  });

  it('rejects guardian tokens on child endpoints and child tokens on guardian endpoints', async () => {
    const { verify } = verifier();
    const app = testApp({ allowDevHeader: false, verifyIdToken: verify });
    expect(
      (
        await app.request('/child', {
          headers: { Authorization: `Bearer ${token({ role: 'guardian' })}` },
        })
      ).status,
    ).toBe(403);
    expect(
      (await app.request('/guardian', { headers: { Authorization: `Bearer ${token()}` } })).status,
    ).toBe(403);
    expect(
      (
        await app.request('/child', {
          headers: { Authorization: `Bearer ${token({ childId: 'a/b' })}` },
        })
      ).status,
    ).toBe(403);
  });

  it('resolves the guardian family server-side, not from claims or client IDs', async () => {
    const { verify } = verifier();
    const app = testApp({ allowDevHeader: false, verifyIdToken: verify });
    const res = await app.request('/guardian?familyId=victim', {
      headers: {
        Authorization: `Bearer ${token({ role: 'guardian', familyId: 'forged-family' })}`,
      },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      role: 'guardian',
      guardianId: 'firebase-uid',
      familyId: 'server-family',
    });
    expect(
      (
        await app.request('/guardian', {
          headers: { Authorization: `Bearer ${token({ role: 'guardian', sub: 'no-membership' })}` },
        })
      ).status,
    ).toBe(403);
  });

  it('does not fall back to dev headers after an invalid token and never enables dev headers in production options', async () => {
    const { verify } = verifier();
    const dev = testApp({ allowDevHeader: true, verifyIdToken: verify });
    expect(
      (
        await dev.request('/child', {
          headers: { Authorization: 'Bearer invalid', 'X-Dev-Child-Id': 'c_dev' },
        })
      ).status,
    ).toBe(401);
    const prod = testApp({ allowDevHeader: false, verifyIdToken: verify });
    expect((await prod.request('/child', { headers: { 'X-Dev-Child-Id': 'c_dev' } })).status).toBe(
      401,
    );
    expect(
      (await prod.request('/guardian', { headers: { 'X-Dev-Guardian-Id': 'g_dev' } })).status,
    ).toBe(401);
  });
});
