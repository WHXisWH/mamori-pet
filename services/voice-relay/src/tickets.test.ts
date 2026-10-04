import { Firestore } from '@google-cloud/firestore';
import { VOICE_TICKETS, tokenDigest } from '@ijime/service-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { redeemTicket } from './tickets.js';

let db: Firestore;
const NOW = new Date('2026-10-01T00:00:00Z');

async function issue(ticket: string, childId: string, expiresAt: Date) {
  await db
    .collection(VOICE_TICKETS)
    .doc(tokenDigest(ticket))
    .set({ childId, familyId: `f_${childId}`, createdAt: NOW, expiresAt });
}

beforeAll(() => {
  if (!process.env['FIRESTORE_EMULATOR_HOST']) throw new Error('needs Firestore emulator');
  db = new Firestore({ projectId: 'demo-ijime' });
});
afterAll(() => db.terminate());

describe('redeemTicket', () => {
  it('succeeds once and binds the ticket’s own child', async () => {
    await issue('tk_once', 'c_a', new Date(NOW.getTime() + 60_000));
    expect(await redeemTicket(db, 'tk_once', NOW)).toEqual({ childId: 'c_a', familyId: 'f_c_a' });
    expect(await redeemTicket(db, 'tk_once', NOW)).toBeNull();
  });

  it('rejects expired, unknown and oversized tickets', async () => {
    await issue('tk_old', 'c_b', new Date(NOW.getTime() - 1));
    expect(await redeemTicket(db, 'tk_old', NOW)).toBeNull();
    expect(await redeemTicket(db, 'tk_nope', NOW)).toBeNull();
    expect(await redeemTicket(db, '', NOW)).toBeNull();
    expect(await redeemTicket(db, 'x'.repeat(200), NOW)).toBeNull();
  });

  it('only one of two concurrent redemptions wins', async () => {
    await issue('tk_race', 'c_c', new Date(NOW.getTime() + 60_000));
    const results = await Promise.all([
      redeemTicket(db, 'tk_race', NOW),
      redeemTicket(db, 'tk_race', NOW),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('stores only the digest, never the ticket', async () => {
    const snap = await db.collection(VOICE_TICKETS).get();
    expect(snap.docs.map((d) => d.id)).not.toContain('tk_once');
    expect(JSON.stringify(snap.docs.map((d) => d.data()))).not.toContain('tk_once');
  });
});
