import { Firestore } from '@google-cloud/firestore';
import { agent, limits } from '@ijime/config';
import type { CrisisCheck, CrisisDetector } from '@ijime/crisis-detector';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  checkWithinBudget,
  consumeArtwork,
  consumeDaily,
  createRateLimiter,
} from './model-budget.js';

const NOW = new Date('2026-10-04T03:00:00.000Z');
const MISS: CrisisCheck = {
  availability: 'verified',
  hit: false,
  category: 'none',
  familyHarmSuspected: false,
  method: 'none',
  keywordMatched: false,
  confidence: 0,
  latencyMs: 1,
};
const input = { text: 'きょうは カレーだった', gradeBand: 'low', priorTurns: [] } as const;

function fakeDetector(keyword = false) {
  const check = vi.fn(async () => MISS);
  const detector = { check, keywordOnly: () => keyword } as unknown as CrisisDetector;
  return { detector, check };
}

let db: Firestore;
let seq = 0;
const base = () => `families/f_budget_${process.pid}/children/c_${seq++}`;
beforeAll(() => {
  if (!process.env['FIRESTORE_EMULATOR_HOST']) throw new Error('needs Firestore emulator');
  db = new Firestore({ projectId: `demo-budget-${process.pid}` });
});
afterAll(() => db.terminate());

describe('createRateLimiter', () => {
  it('allows up to the limit per key in a window, then refuses until the window passes', () => {
    let at = 0;
    const limiter = createRateLimiter(2, 60_000, () => at);
    expect([limiter.allow('a'), limiter.allow('a'), limiter.allow('a')]).toEqual([
      true,
      true,
      false,
    ]);
    expect(limiter.allow('b')).toBe(true);
    at = 59_999;
    expect(limiter.allow('a')).toBe(false);
    at = 60_000;
    expect(limiter.allow('a')).toBe(true);
  });
});

describe('consumeDaily', () => {
  it('counts per child per JST day and stops at the limit', async () => {
    const path = base();
    await db
      .doc(`${path}/chatUsage/2026-10-04_model`)
      .set({ checks: agent.dailyModelCheckLimit - 1 });
    expect(await consumeDaily(db, path, 'checks', NOW)).toBe(true);
    expect(await consumeDaily(db, path, 'checks', NOW)).toBe(false);
    const saved = await db.doc(`${path}/chatUsage/2026-10-04_model`).get();
    expect(saved.get('checks')).toBe(agent.dailyModelCheckLimit);
    expect(saved.get('expireAt').toDate().getTime()).toBe(NOW.getTime() + 2 * 86_400_000);
    // 15:00 UTC is already the next day in Japan
    expect(await consumeDaily(db, path, 'checks', new Date('2026-10-04T15:00:00.000Z'))).toBe(true);
  });

  it('keeps the artwork counter separate from the screening counter', async () => {
    const path = base();
    await db.doc(`${path}/chatUsage/2026-10-04_model`).set({ artworks: limits.artworksPerDay });
    await expect(consumeArtwork(db, path, NOW)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(await consumeDaily(db, path, 'checks', NOW)).toBe(true);
  });
});

describe('checkWithinBudget', () => {
  it('runs the full detector while within both limits', async () => {
    const { detector, check } = fakeDetector();
    const result = await checkWithinBudget(
      { db, detector, limiter: createRateLimiter(5), now: () => NOW },
      { childId: 'c1' },
      base(),
      input,
    );
    expect(result).toBe(MISS);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('rejects without calling any model once the per-minute limit is used up', async () => {
    const { detector, check } = fakeDetector();
    const deps = { db, detector, limiter: createRateLimiter(1), now: () => NOW };
    const path = base();
    await checkWithinBudget(deps, { childId: 'c2' }, path, input);
    await expect(checkWithinBudget(deps, { childId: 'c2' }, path, input)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('rejects without calling any model once the daily limit is used up', async () => {
    const { detector, check } = fakeDetector();
    const path = base();
    await db.doc(`${path}/chatUsage/2026-10-04_model`).set({ checks: agent.dailyModelCheckLimit });
    await expect(
      checkWithinBudget(
        { db, detector, limiter: createRateLimiter(5), now: () => NOW },
        { childId: 'c3' },
        path,
        input,
      ),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(check).not.toHaveBeenCalled();
  });

  it('still treats a keyword hit as a crisis after the limits, without calling a model', async () => {
    const { detector, check } = fakeDetector(true);
    const path = base();
    await db.doc(`${path}/chatUsage/2026-10-04_model`).set({ checks: agent.dailyModelCheckLimit });
    const result = await checkWithinBudget(
      { db, detector, limiter: createRateLimiter(5), now: () => NOW },
      { childId: 'c4' },
      path,
      input,
    );
    expect(result).toMatchObject({
      hit: true,
      method: 'keyword',
      keywordMatched: true,
      familyHarmSuspected: true,
    });
    expect(check).not.toHaveBeenCalled();
  });
});
