import { randomUUID } from 'node:crypto';

import { Firestore } from '@google-cloud/firestore';
import { limits, retention } from '@ijime/config';
import { EnvelopeCipher, LocalKeyWrapper, LocalPseudonymizer } from '@ijime/crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from './app.js';
import type { AccountDeps } from './routes/accounts.js';

let db: Firestore;
let deps: AccountDeps;
let app: ReturnType<typeof createApp>;
let time: Date;
let run: string;
const setGuardianClaims = vi.fn(async (_uid: string, _claims: unknown) => {});
const accounts: Record<string, { email: string; verified?: boolean; role?: string }> = {};

beforeAll(async () => {
  if (!process.env['FIRESTORE_EMULATOR_HOST']) throw new Error('needs Firestore emulator');
  db = new Firestore({ projectId: `demo-invitations-${randomUUID()}` });
});
afterAll(() => db.terminate());
beforeEach(() => {
  time = new Date('2026-10-05T00:00:00Z');
  run = randomUUID().slice(0, 8);
  setGuardianClaims.mockClear();
  deps = {
    db,
    auth: {
      allowDevHeader: false,
      verifyIdToken: async (sub) => {
        const a = accounts[sub];
        if (!a) throw new Error('unknown');
        return {
          sub,
          email: a.email,
          email_verified: a.verified ?? true,
          ...(a.role ? { role: a.role } : {}),
        };
      },
    },
    cipher: new EnvelopeCipher(new LocalKeyWrapper(Buffer.alloc(32, 3))),
    pseudonymizer: new LocalPseudonymizer(),
    issuer: {
      developmentOnly: false,
      issueChildToken: async () => 'unused',
      setGuardianClaims,
    },
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

function account(name: string, email = `${name}-${run}@example.invalid`, extra = {}) {
  const sub = `${name}_${run}`;
  accounts[sub] = { email, ...extra };
  return sub;
}

function request(sub: string, path: string, method = 'GET', body?: unknown) {
  return app.request(path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sub}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

let families = 0;
async function primaryFamily(consented = true) {
  const primary = account(`primary${++families}`);
  const res = await request(primary, '/v1/families', 'POST', {});
  expect(res.status).toBe(201);
  const { familyId } = (await res.json()) as { familyId: string };
  if (consented)
    for (const type of ['guardian_terms', 'guardian_sensitive'])
      expect(
        (
          await request(primary, '/v1/consents', 'POST', {
            type,
            documentVersion: 'v0.1',
            scope: { service: true },
          })
        ).status,
      ).toBe(201);
  return { primary, familyId };
}

async function invite(from: string, email: string) {
  return request(from, '/v1/guardians/invitations', 'POST', { email });
}

async function invitationFor(from: string, email: string) {
  const res = await invite(from, email);
  expect(res.status).toBe(201);
  return (await res.json()) as { invitationId: string; expiresAt: string };
}

const accept = (sub: string, id: string) =>
  request(sub, `/v1/guardians/invitations/${id}/accept`, 'POST', {});

describe('second guardian invitation', () => {
  it('lets the primary invite, and the invited address accept exactly once', async () => {
    const { primary, familyId } = await primaryFamily();
    const second = account('second');
    const inv = await invitationFor(primary, accounts[second]!.email.toUpperCase());
    expect(inv.invitationId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(Date.parse(inv.expiresAt) - time.getTime()).toBe(retention.invitationDays * 86_400_000);

    // the bearer token itself is never stored
    const stored = await db.collection(`families/${familyId}/invitations`).get();
    expect(stored.size).toBe(1);
    expect(stored.docs[0]!.id).not.toBe(inv.invitationId);
    expect(JSON.stringify(stored.docs[0]!.data())).not.toContain(inv.invitationId);
    expect(stored.docs[0]!.get('email')).toBe(accounts[second]!.email);

    const res = await accept(second, inv.invitationId);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ familyId });
    expect(setGuardianClaims).toHaveBeenLastCalledWith(second, {
      role: 'guardian',
      familyId,
      guardianRole: 'secondary',
    });
    const member = await db.doc(`families/${familyId}/guardians/${second}`).get();
    expect(member.data()).toMatchObject({
      guardianId: second,
      role: 'secondary',
      email: accounts[second]!.email,
      notifyChannels: ['webpush', 'email'],
      invitedBy: primary,
    });
    const me = (await (await request(second, '/v1/me')).json()) as {
      guardian: { role: string };
    };
    expect(me.guardian.role).toBe('secondary');
    expect(JSON.stringify(me)).not.toMatch(/riskLevel|currentRiskLevel/);

    // a retry by the same person succeeds (e.g. after the claims call failed)
    expect((await accept(second, inv.invitationId)).status).toBe(200);
    // anyone else gets INVITATION_EXPIRED for a used invitation
    const third = account('third', accounts[second]!.email);
    expect((await accept(third, inv.invitationId)).status).toBe(410);
  });

  it('enforces the permission matrix for the secondary guardian', async () => {
    const { primary } = await primaryFamily();
    const second = account('second');
    const inv = await invitationFor(primary, accounts[second]!.email);
    expect((await accept(second, inv.invitationId)).status).toBe(200);

    expect((await invite(second, 'someone@example.invalid')).status).toBe(403);
    expect(
      (
        await request(second, '/v1/consents', 'POST', {
          type: 'guardian_terms',
          documentVersion: 'v0.2',
        })
      ).status,
    ).toBe(403);
    expect(
      (await request(second, '/v1/children', 'POST', { nickname: 'そら', gradeBand: 'high' }))
        .status,
    ).toBe(403);
    expect((await request(second, '/v1/consents')).status).toBe(200);
  });

  it('allows only one secondary guardian', async () => {
    const { primary } = await primaryFamily();
    const [a, b] = [account('a'), account('b')];
    const first = await invitationFor(primary, accounts[a]!.email);
    const pending = await invitationFor(primary, accounts[b]!.email);
    expect((await accept(a, first.invitationId)).status).toBe(200);
    expect((await invite(primary, 'c@example.invalid')).status).toBe(409);
    expect((await accept(b, pending.invitationId)).status).toBe(409);
  });

  it('rejects the wrong account, unverified email, child tokens and members of other families', async () => {
    const { primary } = await primaryFamily();
    const invited = account('invited');
    const inv = await invitationFor(primary, accounts[invited]!.email);

    expect((await accept(account('stranger'), inv.invitationId)).status).toBe(403);
    expect(
      (
        await accept(
          account('unverified', accounts[invited]!.email, { verified: false }),
          inv.invitationId,
        )
      ).status,
    ).toBe(403);
    expect(
      (await accept(account('kid', accounts[invited]!.email, { role: 'child' }), inv.invitationId))
        .status,
    ).toBe(403);

    // the invited address already runs its own family
    const own = await primaryFamily();
    const crossInv = await invitationFor(primary, accounts[own.primary]!.email);
    expect(own.primary).not.toBe(primary);
    expect((await accept(own.primary, crossInv.invitationId)).status).toBe(409);

    // the invitation is still usable by the right person afterwards
    expect((await accept(invited, inv.invitationId)).status).toBe(200);
  });

  it('expires after the configured days', async () => {
    const { primary } = await primaryFamily();
    const second = account('late');
    const inv = await invitationFor(primary, accounts[second]!.email);
    time = new Date(time.getTime() + retention.invitationDays * 86_400_000);
    expect((await accept(second, inv.invitationId)).status).toBe(410);
  });

  it('returns NOT_FOUND for unknown or malformed invitations', async () => {
    const someone = account('someone');
    expect((await accept(someone, 'A'.repeat(22))).status).toBe(404);
    expect((await accept(someone, 'not-a-token')).status).toBe(404);
  });

  it('validates the request and requires a consented family and the primary role', async () => {
    const unconsented = await primaryFamily(false);
    expect((await invite(unconsented.primary, 'x@example.invalid')).status).toBe(403);

    const { primary } = await primaryFamily();
    expect((await invite(primary, 'not-an-email')).status).toBe(400);
    expect((await invite(primary, accounts[primary]!.email)).status).toBe(400);
    expect((await invite(account('nobody'), 'x@example.invalid')).status).toBe(404);
  });

  it('bounds the number of pending invitations per family', async () => {
    const { primary } = await primaryFamily();
    for (let i = 0; i < limits.pendingInvitationsPerFamily; i++)
      await invitationFor(primary, `p${i}@example.invalid`);
    expect((await invite(primary, 'over@example.invalid')).status).toBe(429);
    time = new Date(time.getTime() + retention.invitationDays * 86_400_000 + 1);
    expect((await invite(primary, 'later@example.invalid')).status).toBe(201);
  });

  it('fails closed when custom claims cannot be set, and the retry completes', async () => {
    const { primary, familyId } = await primaryFamily();
    const second = account('retry');
    const inv = await invitationFor(primary, accounts[second]!.email);
    setGuardianClaims.mockRejectedValueOnce(new Error('identity toolkit down'));
    expect((await accept(second, inv.invitationId)).status).toBe(503);
    const res = await accept(second, inv.invitationId);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ familyId });
  });
});
