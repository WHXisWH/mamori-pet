import { randomUUID } from 'node:crypto';

import { Firestore } from '@google-cloud/firestore';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FirestoreChildDirectory,
  FirestoreSessionService,
  LocalChildDirectory,
} from '@ijime/agent-core';
import { EnvelopeCipher, LocalKeyWrapper, LocalPseudonymizer } from '@ijime/crypto';
import { FsKbSource, Kb } from '@ijime/kb-loader';
import { limits, rateLimit } from '@ijime/config';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from './app.js';
import { shardCaps } from './pairing-limiter.js';
import type { AccountDeps } from './routes/accounts.js';
import type { ChatDeps } from './chat.js';

let db: Firestore;
let deps: AccountDeps;
let app: ReturnType<typeof createApp>;
let time: Date;
let guardian: string;
const wrapper = new LocalKeyWrapper(Buffer.alloc(32, 7));
const issueChildToken = vi.fn(async (claims: { childId: string }) => `fixture-${claims.childId}`);
const setGuardianClaims = vi.fn(async () => {});

beforeAll(async () => {
  if (!process.env['FIRESTORE_EMULATOR_HOST']) throw new Error('needs Firestore emulator');
  db = new Firestore({ projectId: `demo-accounts-${randomUUID()}` });
});
afterAll(() => db.terminate());
beforeEach(() => {
  time = new Date('2026-10-02T00:00:00Z');
  guardian = `g_${randomUUID()}`;
  issueChildToken.mockClear();
  setGuardianClaims.mockClear();
  deps = {
    db,
    auth: {
      allowDevHeader: false,
      verifyIdToken: async (sub) => ({
        sub,
        email: 'fixture@example.invalid',
        email_verified: true,
      }),
    },
    cipher: new EnvelopeCipher(wrapper),
    pseudonymizer: new LocalPseudonymizer(),
    issuer: { developmentOnly: false, issueChildToken, setGuardianClaims },
    verifyConsent: async () => ({ method: 'offline_verified_fixture' }),
    now: () => time,
  };
  app = createApp({
    getKb: async () => {
      throw new Error('account routes do not load the KB');
    },
    allowedOrigins: [],
    accounts: async () => deps,
  });
});

function request(
  path: string,
  method = 'GET',
  body?: unknown,
  identity: string | null = guardian,
  extra: Record<string, string> = {},
) {
  return app.request(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(identity ? { Authorization: `Bearer ${identity}` } : {}),
      ...extra,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function family() {
  const res = await request('/v1/families', 'POST', { displayName: 'synthetic guardian' });
  expect(res.status).toBe(201);
  return (await res.json()) as { familyId: string };
}
async function consent(type = 'guardian_terms') {
  const res = await request('/v1/consents', 'POST', {
    type,
    documentVersion: 'v0.1',
    scope: { service: true },
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { consentId: string };
}
async function setup() {
  const f = await family();
  const terms = await consent();
  await consent('guardian_sensitive');
  const res = await request('/v1/children', 'POST', { nickname: 'そら', gradeBand: 'high' });
  expect(res.status).toBe(201);
  return { ...f, ...terms, ...((await res.json()) as { childId: string }) };
}
async function code(childId: string) {
  const res = await request(`/v1/children/${childId}/pairing-codes`, 'POST', {});
  expect(res.status).toBe(201);
  return (await res.json()) as { code: string; expiresAt: string };
}

describe('account and one-use pairing workflow', () => {
  it('requires an authenticated non-child identity and disallows development headers in production', async () => {
    expect((await request('/v1/families', 'POST', {}, null)).status).toBe(401);
    expect(
      (await request('/v1/families', 'POST', {}, null, { 'X-Dev-Guardian-Id': 'g_fake' })).status,
    ).toBe(401);
    deps.auth.verifyIdToken = async () => ({ sub: 'child-uid', role: 'child' });
    expect((await request('/v1/families', 'POST', {})).status).toBe(403);
  });

  it('creates one family under concurrent retry and only exposes the documented guardian projection', async () => {
    const replies = await Promise.all([family(), family()]);
    expect(replies[0]).toEqual(replies[1]);
    const me = await (await request('/v1/me')).json();
    expect(me).toEqual({
      guardian: {
        guardianId: guardian,
        role: 'primary',
        email: 'fixture@example.invalid',
        displayName: 'synthetic guardian',
      },
      family: { familyId: replies[0]!.familyId, termsVersion: '', consentComplete: false },
      children: [],
    });
    expect(setGuardianClaims).toHaveBeenCalled();
    expect(
      (await db.collection('families').where('primaryGuardianId', '==', guardian).get()).size,
    ).toBe(1);
  });

  it('requires both explicit consents, encrypts child keys, and enforces child-creation idempotency', async () => {
    const { familyId } = await family();
    const create = (nickname = 'そら') =>
      request('/v1/children', 'POST', { nickname, gradeBand: 'low' }, guardian, {
        'Idempotency-Key': 'new-child',
      });
    expect((await create()).status).toBe(403);
    await consent();
    expect((await create()).status).toBe(403);
    await consent('guardian_sensitive');
    const replies = await Promise.all([create(), create()]);
    expect(replies.map((r) => r.status)).toEqual([201, 201]);
    const [first, second] = await Promise.all(
      replies.map((r) => r.json() as Promise<{ childId: string }>),
    );
    expect(first).toEqual(second);
    expect((await create('べつの子')).status).toBe(409);
    const child = await new FirestoreChildDirectory(db, wrapper).lookup(first!.childId);
    expect(child?.familyId).toBe(familyId);
    const doc = await db.doc(`families/${familyId}/children/${first!.childId}`).get();
    expect(doc.get('wrappedDek')).toBeDefined();
    expect(doc.get('dek')).toBeUndefined();
    expect(doc.get('assentComplete')).toBe(false);
    expect(Object.values(doc.get('dataSources'))).toEqual(expect.arrayContaining([false]));
    const me = await (await request('/v1/me')).text();
    for (const secret of ['wrappedDek', 'pseudoId', 'currentRiskLevel'])
      expect(me).not.toContain(secret);
  });

  it('limits how many children one family can register', async () => {
    await setup();
    for (let i = 1; i < limits.childrenPerFamily; i++)
      expect(
        (await request('/v1/children', 'POST', { nickname: `こ${i}`, gradeBand: 'low' })).status,
      ).toBe(201);
    const over = await request('/v1/children', 'POST', {
      nickname: 'もうひとり',
      gradeBand: 'low',
    });
    expect(over.status).toBe(429);
    expect(((await over.json()) as { error: { code: string } }).error.code).toBe('RATE_LIMITED');
  });

  it('issues one valid token under concurrent redemption and never stores or returns it in me', async () => {
    const { childId, familyId } = await setup();
    const pairing = await code(childId);
    expect(pairing.code).toMatch(/^\d{6}$/);
    expect(Date.parse(pairing.expiresAt) - time.getTime()).toBe(600_000);
    const results = await Promise.all([
      request('/v1/child/pair', 'POST', { code: pairing.code }, null),
      request('/v1/child/pair', 'POST', { code: pairing.code }, null),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 410]);
    expect(issueChildToken).toHaveBeenCalledTimes(1);
    expect(issueChildToken).toHaveBeenCalledWith({
      role: 'child',
      familyId,
      childId,
      gradeBand: 'high',
    });
    expect(await results.find((r) => r.status === 200)!.json()).toEqual({
      customToken: `fixture-${childId}`,
      childId,
      needsAssent: true,
    });
    expect(await (await request('/v1/me')).json()).toMatchObject({
      children: [{ childId, paired: true, assentComplete: false }],
    });
  });

  it('requires the requesting guardian to be verified, permits either guardian role, and rejects revoked membership', async () => {
    const { childId, familyId } = await setup();
    const primary = guardian;
    guardian = `g_${randomUUID()}`;
    const member = db.doc(`families/${familyId}/guardians/${guardian}`);
    await member.set({ guardianId: guardian, role: 'secondary', email: 'second@example.invalid' });
    const issue = () => request(`/v1/children/${childId}/pairing-codes`, 'POST', {});
    expect((await issue()).status).toBe(403);
    await member.update({ verifiedAt: time });
    expect((await issue()).status).toBe(201);
    const created = await db.collection(`families/${familyId}/pairingCodes`).get();
    expect(created.docs.every((doc) => doc.get('createdBy') === guardian)).toBe(true);
    await member.update({ role: 'viewer' });
    expect((await issue()).status).toBe(403);
    await member.update({ role: 'secondary', revokedAt: time });
    expect((await issue()).status).toBe(403);
    guardian = primary;
    expect((await issue()).status).toBe(201);
  });

  it('keeps explicit local-demo onboarding unverified while allowing its synthetic pairing flow', async () => {
    deps.auth.allowDevHeader = true;
    deps.issuer!.developmentOnly = true;
    deps.verifyConsent = undefined;
    const local = (path: string, body: unknown) =>
      request(path, 'POST', body, null, { 'X-Dev-Guardian-Id': guardian });
    const familyResponse = await local('/v1/families', {});
    expect(familyResponse.status).toBe(201);
    const { familyId } = (await familyResponse.json()) as { familyId: string };
    for (const type of ['guardian_terms', 'guardian_sensitive'])
      expect((await local('/v1/consents', { type, documentVersion: 'v0.1' })).status).toBe(201);
    const childResponse = await local('/v1/children', { nickname: 'そら', gradeBand: 'low' });
    expect(childResponse.status).toBe(201);
    const { childId } = (await childResponse.json()) as { childId: string };
    const pairingResponse = await local(`/v1/children/${childId}/pairing-codes`, {});
    expect(pairingResponse.status).toBe(201);
    const pairing = (await pairingResponse.json()) as { code: string };
    expect((await request('/v1/child/pair', 'POST', { code: pairing.code }, null)).status).toBe(
      200,
    );
    expect(
      (await db.doc(`families/${familyId}/guardians/${guardian}`).get()).get('verifiedAt'),
    ).toBeUndefined();
    const records = await db.collection(`families/${familyId}/consents`).get();
    expect(
      records.docs.every((doc) => doc.get('verificationMethod') === 'local_demo_unverified'),
    ).toBe(true);
  });

  it('rejects expired, invalid, superseded and foreign-family codes', async () => {
    const { childId } = await setup();
    const old = await code(childId);
    const fresh = await code(childId);
    expect((await request('/v1/child/pair', 'POST', { code: old.code }, null)).status).toBe(410);
    time = new Date(time.getTime() + 600_001);
    expect((await request('/v1/child/pair', 'POST', { code: fresh.code }, null)).status).toBe(410);
    expect((await request('/v1/child/pair', 'POST', { code: 'abcdef' }, null)).status).toBe(400);
    guardian = `g_${randomUUID()}`;
    await family();
    await consent();
    await consent('guardian_sensitive');
    expect((await request(`/v1/children/${childId}/pairing-codes`, 'POST', {})).status).toBe(404);
    expect(issueChildToken).not.toHaveBeenCalled();
  });

  it('withdrawal preserves the audit record, pauses children and blocks existing pairing codes', async () => {
    const { childId, familyId, consentId } = await setup();
    const pairing = await code(childId);
    expect((await request(`/v1/consents/${consentId}`, 'DELETE')).status).toBe(204);
    expect((await request(`/v1/consents/${consentId}`, 'DELETE')).status).toBe(204);
    expect(
      (await db.doc(`families/${familyId}/consents/${consentId}`).get()).get('revokedAt'),
    ).toBeDefined();
    expect((await db.doc(`families/${familyId}/children/${childId}`).get()).get('status')).toBe(
      'paused',
    );
    expect((await request('/v1/child/pair', 'POST', { code: pairing.code }, null)).status).toBe(
      403,
    );
    expect(
      (await request('/v1/children', 'POST', { nickname: 'そら', gradeBand: 'high' })).status,
    ).toBe(403);
    expect(await (await request('/v1/me')).json()).toMatchObject({
      family: { consentComplete: false },
    });
  });

  it('does not accept a claimed verification method without an actual verifier', async () => {
    await family();
    deps.verifyConsent = undefined;
    const res = await request('/v1/consents', 'POST', {
      type: 'guardian_terms',
      documentVersion: 'v0.1',
      verification: { method: 'verified' },
    });
    expect(res.status).toBe(503);
    expect((await request('/v1/me')).status).toBe(200);
  });

  it('fails closed on issuer failure, burns the code and redacts provider errors', async () => {
    const { childId } = await setup();
    const pairing = await code(childId);
    issueChildToken.mockRejectedValueOnce(new Error('secret-provider-token'));
    const res = await request('/v1/child/pair', 'POST', { code: pairing.code }, null);
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain('secret-provider-token');
    expect((await request('/v1/child/pair', 'POST', { code: pairing.code }, null)).status).toBe(
      410,
    );
  });

  it('withholds a token if consent is revoked during issuance', async () => {
    const { childId, consentId } = await setup();
    const pairing = await code(childId);
    issueChildToken.mockImplementationOnce(async () => {
      await request(`/v1/consents/${consentId}`, 'DELETE');
      return 'never-return-this';
    });
    const res = await request('/v1/child/pair', 'POST', { code: pairing.code }, null);
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain('never-return-this');
  });

  it('resolves registered children before fixtures, requires local assent, and suppresses completed daily checkins', async () => {
    const { childId, familyId } = await setup();
    const directory = new LocalChildDirectory(db, wrapper);
    expect((await directory.lookup(childId))?.familyId).toBe(familyId);
    expect(await directory.lookup('unknown_uuid')).toBeUndefined();
    const chat = {
      db,
      directory,
      sessions: new FirestoreSessionService(db, directory),
      auth: { allowDevHeader: true },
      openings: { low: ['hello'], high: ['hello'], jhs: ['hello'] },
    } as unknown as ChatDeps;
    const kb = await Kb.load(
      new FsKbSource(join(dirname(fileURLToPath(import.meta.url)), '../../../kb/v0.1.0')),
    );
    const full = createApp({ getKb: async () => kb, allowedOrigins: [], chat: async () => chat });
    const headers = { 'X-Dev-Child-Id': childId, 'Content-Type': 'application/json' };
    expect((await full.request('/v1/child/home', { headers })).status).toBe(403);
    expect(
      (
        await full.request('/v1/child/assent', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            documentVersion: 'v0.1',
            dataSources: {
              voice: false,
              typing: false,
              artwork_save: false,
              home_checkin: true,
              calendar: false,
            },
          }),
        })
      ).status,
    ).toBe(201);
    expect(await (await full.request('/v1/child/home', { headers })).json()).toMatchObject({
      showHomeCheckin: true,
    });
    const base = `families/${familyId}/children/${childId}`;
    await db
      .doc(`${base}/homeCheckins/yesterday`)
      .set({ localDate: '2000-01-01', atHome: true, checkinAt: new Date(0) });
    expect(await (await full.request('/v1/child/home', { headers })).json()).toMatchObject({
      showHomeCheckin: true,
    });
    await db.doc(`${base}/homeCheckins/today`).set({
      localDate: new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10),
      atHome: false,
      checkinAt: new Date(),
    });
    expect(await (await full.request('/v1/child/home', { headers })).json()).toMatchObject({
      showHomeCheckin: false,
    });
    await db.doc(base).update({ status: 'paused' });
    expect(await directory.lookup(childId)).toBeUndefined();
    expect((await db.doc(`families/f_dev_${childId}/children/${childId}`).get()).exists).toBe(
      false,
    );
  });

  it('lists consent receipts without verification secrets or other families and rejects foreign withdrawal', async () => {
    const { consentId } = await setup();
    const records = (await (await request('/v1/consents')).json()) as {
      items: Record<string, unknown>[];
    };
    expect(records.items).toHaveLength(2);
    expect(records.items[0]).not.toHaveProperty('requestHash');
    expect(records.items[0]).not.toHaveProperty('verification');
    guardian = `g_${randomUUID()}`;
    await family();
    expect(await (await request('/v1/consents')).json()).toEqual({ items: [] });
    expect((await request(`/v1/consents/${consentId}`, 'DELETE')).status).toBe(404);
  });

  it('rejects local-only issuers in a non-development authentication configuration', async () => {
    deps.issuer = { developmentOnly: true, issueChildToken, setGuardianClaims };
    const res = await request('/v1/families', 'POST', {});
    expect(res.status).toBe(503);
    expect(setGuardianClaims).not.toHaveBeenCalled();
  });

  it('bounds anonymous pairing attempts across requests before contacting the issuer', async () => {
    const window = Math.floor(time.getTime() / 60_000);
    const caps = shardCaps({
      perMinute: rateLimit.childRequestsPerMinute,
      shards: rateLimit.pairingShards,
    });
    await Promise.all(
      caps.map((count, i) => db.doc(`pairingAttempts/public-${i}`).set({ window, count })),
    );
    expect((await request('/v1/child/pair', 'POST', { code: '000000' }, null)).status).toBe(429);
    expect(issueChildToken).not.toHaveBeenCalled();
    await Promise.all(caps.map((_, i) => db.doc(`pairingAttempts/public-${i}`).delete()));
  });
});
