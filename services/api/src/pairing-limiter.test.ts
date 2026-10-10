import { randomUUID } from 'node:crypto';

import { Firestore } from '@google-cloud/firestore';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { shardCaps, takePairingSlot } from './pairing-limiter.js';

// テストケースごとに独立したプロジェクトを使う：カウント文書は分単位のウィンドウで増えるため、ケース間で共有できない
let db: Firestore;

beforeAll(() => {
  if (!process.env['FIRESTORE_EMULATOR_HOST']) throw new Error('needs Firestore emulator');
});
beforeEach(() => {
  db = new Firestore({ projectId: `demo-pairing-${randomUUID().slice(0, 8)}` });
});
afterEach(() => db.terminate());

describe('pairing limiter', () => {
  it('splits the total across shards without losing any of it', () => {
    expect(shardCaps({ perMinute: 60, shards: 6 })).toEqual([10, 10, 10, 10, 10, 10]);
    expect(shardCaps({ perMinute: 20, shards: 6 })).toEqual([4, 4, 3, 3, 3, 3]);
    expect(shardCaps({ perMinute: 2, shards: 4 })).toEqual([1, 1, 0, 0]);
  });

  it('never admits more than the total under concurrency', async () => {
    const now = new Date('2026-10-05T00:00:10Z');
    const limit = { perMinute: 10, shards: 5 };
    const results = await Promise.all(
      Array.from({ length: 30 }, () => takePairingSlot(db, now, limit)),
    );
    // 競合で失敗したリクエストは制限として拒否されるので、通過数は上限より少なくなりうるが、上限を超えることはなく、カウントとも一致する
    const admitted = results.filter(Boolean).length;
    expect(admitted).toBeGreaterThan(0);
    expect(admitted).toBeLessThanOrEqual(10);
    const docs = await db.collection('pairingAttempts').get();
    expect(docs.docs.reduce((sum, d) => sum + Number(d.get('count')), 0)).toBe(admitted);
  });

  it('treats a shard whose transaction keeps aborting as full and tries the next one', async () => {
    const aborted = Object.assign(new Error('contention'), { code: 10 });
    let calls = 0;
    const flaky = {
      doc: db.doc.bind(db),
      runTransaction: (fn: Parameters<Firestore['runTransaction']>[0]) =>
        calls++ === 0 ? Promise.reject(aborted) : db.runTransaction(fn),
    } as unknown as Firestore;
    const now = new Date('2026-10-05T00:04:10Z');
    expect(await takePairingSlot(flaky, now, { perMinute: 2, shards: 2 }, () => 0)).toBe(true);
    expect(calls).toBe(2);

    const broken = {
      doc: db.doc.bind(db),
      runTransaction: () => Promise.reject(new Error('unavailable')),
    } as unknown as Firestore;
    await expect(takePairingSlot(broken, now, { perMinute: 2, shards: 2 })).rejects.toThrow(
      'unavailable',
    );
  });

  it('moves on to another shard when the random one is full', async () => {
    const now = new Date('2026-10-05T00:01:10Z');
    const limit = { perMinute: 2, shards: 2 };
    // 毎回シャード 0 から始める：2回目のリクエストはシャード 1 に移らないと誤って拒否される
    const first = () => takePairingSlot(db, now, limit, () => 0);
    expect(await first()).toBe(true);
    expect(await first()).toBe(true);
    expect(await first()).toBe(false);
  });

  it('a late request never resets a newer minute window', async () => {
    const limit = { perMinute: 1, shards: 1 };
    expect(await takePairingSlot(db, new Date('2026-10-05T00:06:00Z'), limit)).toBe(true);
    expect(await takePairingSlot(db, new Date('2026-10-05T00:05:59Z'), limit)).toBe(false);
    expect(await takePairingSlot(db, new Date('2026-10-05T00:06:30Z'), limit)).toBe(false);
  });

  it('starts a fresh count in the next calendar minute', async () => {
    const limit = { perMinute: 1, shards: 1 };
    expect(await takePairingSlot(db, new Date('2026-10-05T00:02:59Z'), limit)).toBe(true);
    expect(await takePairingSlot(db, new Date('2026-10-05T00:02:59Z'), limit)).toBe(false);
    expect(await takePairingSlot(db, new Date('2026-10-05T00:03:00Z'), limit)).toBe(true);
  });
});
