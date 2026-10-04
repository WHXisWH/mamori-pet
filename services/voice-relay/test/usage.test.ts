import { Firestore } from '@google-cloud/firestore';
import { DevChildDirectory, FirestoreSessionService } from '@ijime/agent-core';
import { agent } from '@ijime/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FirestoreVoiceStore } from '../src/store.js';

let db: Firestore;
let sequence = 0;
beforeAll(() => {
  if (!process.env['FIRESTORE_EMULATOR_HOST']) throw new Error('needs Firestore emulator');
  db = new Firestore({ projectId: `demo-voice-usage-${Date.now()}` });
});
afterAll(() => db.terminate());

async function setup() {
  const directory = new DevChildDirectory(db);
  const child = (await directory.lookup(`c_usage_${sequence++}`))!;
  const root = db.doc(`families/${child.familyId}/children/${child.childId}`);
  const sessions = new FirestoreSessionService(db, directory);
  const clock = { now: new Date('2026-10-01T14:59:59.000Z') };
  const session = await sessions.createSession({
    appName: 'pet',
    userId: child.childId,
    state: { channel: 'voice' },
  });
  const storeFor = (id: string) =>
    new FirestoreVoiceStore(db, sessions, child, id, () => clock.now);
  return { root, child, sessions, session, clock, storeFor, store: storeFor(session.id) };
}

describe('shared JST text and voice usage', () => {
  it('reserves the last slot in the existing API counter and denies the next voice turn', async () => {
    const t = await setup();
    const usage = t.root.collection('chatUsage').doc('2026-10-01');
    await usage.set({ turns: agent.dailyTurnLimit - 1 });
    expect(await t.store.reserveOrdinaryTurn('first')).toBe(true);
    expect(await t.store.reserveOrdinaryTurn('second')).toBe(false);
    const saved = await usage.get();
    expect(saved.get('turns')).toBe(agent.dailyTurnLimit);
    expect(saved.get('expireAt').toDate().getTime()).toBe(t.clock.now.getTime() + 2 * 86_400_000);
  });

  it('does not double charge a retry, including another store instance on reconnect', async () => {
    const t = await setup();
    expect(await t.store.reserveOrdinaryTurn('connection-a:1')).toBe(true);
    expect(await t.storeFor(t.session.id).reserveOrdinaryTurn('connection-a:1')).toBe(true);
    expect(await t.storeFor(t.session.id).reserveOrdinaryTurn('connection-b:1')).toBe(true);
    expect((await t.root.collection('chatUsage').doc('2026-10-01').get()).get('turns')).toBe(2);
  });

  it('does not lose a receipt when text chat overwrites the usage document', async () => {
    const t = await setup();
    const usage = t.root.collection('chatUsage').doc('2026-10-01');
    await t.store.reserveOrdinaryTurn('accepted');
    await usage.set({ turns: 2, expireAt: new Date(t.clock.now.getTime() + 2 * 86_400_000) });
    expect(await t.store.reserveOrdinaryTurn('accepted')).toBe(true);
    expect((await usage.get()).get('turns')).toBe(2);
  });

  it('atomically charges concurrent duplicate delivery once', async () => {
    const t = await setup();
    const results = await Promise.all(
      Array.from({ length: 4 }, () => t.store.reserveOrdinaryTurn('same-operation')),
    );
    expect(results).toEqual([true, true, true, true]);
    expect((await t.root.collection('chatUsage').doc('2026-10-01').get()).get('turns')).toBe(1);
  });

  it('serializes text and multiple voice sessions competing for the last slot', async () => {
    const t = await setup();
    const second = await t.sessions.createSession({
      appName: 'pet',
      userId: t.child.childId,
      state: { channel: 'voice' },
    });
    const usage = t.root.collection('chatUsage').doc('2026-10-01');
    await usage.set({ turns: agent.dailyTurnLimit - 1 });
    // Match the API's read/check/set transaction, including its non-merge write.
    const textReservation = () =>
      db.runTransaction(async (tx) => {
        const owner = await tx.get(t.root);
        const snapshot = await tx.get(usage);
        if (owner.get('status') !== 'active') return false;
        const turns = Number(snapshot.get('turns') ?? 0);
        if (turns >= agent.dailyTurnLimit) return false;
        tx.set(usage, {
          turns: turns + 1,
          expireAt: new Date(t.clock.now.getTime() + 2 * 86_400_000),
        });
        return true;
      });
    const results = await Promise.all([
      t.store.reserveOrdinaryTurn('a'),
      t.storeFor(second.id).reserveOrdinaryTurn('b'),
      textReservation(),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await usage.get()).get('turns')).toBe(agent.dailyTurnLimit);
  });

  it('opens the next JST day without resetting yesterday or recharging an accepted utterance', async () => {
    const t = await setup();
    const yesterday = t.root.collection('chatUsage').doc('2026-10-01');
    await yesterday.set({ turns: agent.dailyTurnLimit - 1 });
    expect(await t.store.reserveOrdinaryTurn('yesterday')).toBe(true);
    t.clock.now = new Date('2026-10-01T15:00:00.000Z');
    expect(await t.store.reserveOrdinaryTurn('yesterday')).toBe(true);
    expect(await t.store.reserveOrdinaryTurn('today')).toBe(true);
    expect((await yesterday.get()).get('turns')).toBe(agent.dailyTurnLimit);
    expect((await t.root.collection('chatUsage').doc('2026-10-02').get()).get('turns')).toBe(1);
  });

  it.each([
    'paused',
    'deleting',
    'voice_disabled',
    'missing_child',
    'missing_session',
    'safe_mode',
    'ended',
  ])(
    'does not grant or debit quota when authorization changes to %s, even with a receipt',
    async (change) => {
      const t = await setup();
      await t.store.reserveOrdinaryTurn('before');
      const session = t.root.collection('sessions').doc(t.session.id);
      if (change === 'missing_child') await t.root.delete();
      else if (change === 'missing_session') await session.delete();
      else if (change === 'safe_mode') await session.update({ safeMode: true });
      else if (change === 'ended') await session.update({ endedAt: t.clock.now });
      else
        await t.root.update(
          change === 'voice_disabled' ? { 'dataSources.voice': false } : { status: change },
        );
      expect(await t.store.reserveOrdinaryTurn('before')).toBe(false);
      expect(await t.store.reserveOrdinaryTurn('after')).toBe(false);
      expect((await t.root.collection('chatUsage').doc('2026-10-01').get()).get('turns')).toBe(1);
    },
  );

  it.each(['open', 'guardian_acknowledged', 'unknown', 'missing'])(
    'denies new turns and prior receipts while another session has a %s crisis',
    async (status) => {
      const t = await setup();
      expect(await t.store.reserveOrdinaryTurn('before')).toBe(true);
      const otherSession = await t.sessions.createSession({
        appName: 'pet',
        userId: t.child.childId,
        state: { channel: 'text' },
      });
      await t.root
        .collection('crisisEvents')
        .doc('other-session-crisis')
        .set({
          sourceRef: `${t.root.path}/sessions/${otherSession.id}`,
          ...(status === 'missing' ? {} : { status }),
        });
      expect(await t.store.reserveOrdinaryTurn('before')).toBe(false);
      expect(await t.store.reserveOrdinaryTurn('after')).toBe(false);
      expect((await t.root.collection('chatUsage').doc('2026-10-01').get()).get('turns')).toBe(1);
    },
  );

  it('allows ordinary usage after a crisis is explicitly closed', async () => {
    const t = await setup();
    await t.root.collection('crisisEvents').doc('resolved').set({ status: 'closed' });
    expect(await t.store.reserveOrdinaryTurn('after-closure')).toBe(true);
    expect((await t.root.collection('chatUsage').doc('2026-10-01').get()).get('turns')).toBe(1);
  });

  it('never charges another child when the session ID is from a different owner', async () => {
    const t = await setup();
    const other = await setup();
    expect(await t.storeFor(other.session.id).reserveOrdinaryTurn('wrong-owner')).toBe(false);
    expect((await t.root.collection('chatUsage').get()).empty).toBe(true);
    expect((await other.root.collection('chatUsage').get()).empty).toBe(true);
  });
});
