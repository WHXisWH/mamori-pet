import { Firestore } from '@google-cloud/firestore';
import { VOICE_FLAG_DOC } from '@ijime/agent-core';
import { encodePushEnvelope, Logger } from '@ijime/service-kit';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { BUDGET_ALERT_PATH, handleBudgetAlert, type BudgetAlert } from './budget.js';
import type { NotifierDeps } from './deps.js';

let db: Firestore;
const logs: string[] = [];
const deps = () => ({
  db,
  logger: new Logger('notifier', (line) => logs.push(line)),
  now: () => new Date('2026-10-05T00:00:00Z'),
});
const alert = (costAmount: number, period = '2026-10-01T07:00:00Z'): BudgetAlert => ({
  costAmount,
  budgetAmount: 75_000,
  costIntervalStart: period,
});
const flag = async () => (await db.doc(VOICE_FLAG_DOC).get()).data();

beforeAll(() => {
  if (!process.env['FIRESTORE_EMULATOR_HOST']) throw new Error('needs Firestore emulator');
  db = new Firestore({ projectId: 'demo-ijime-budget' });
});
beforeEach(async () => {
  logs.length = 0;
  await db.doc(VOICE_FLAG_DOC).delete();
});
afterAll(() => db.terminate());

describe('budget alerts switch voice off', () => {
  it('leaves voice on below the breaker threshold', async () => {
    await handleBudgetAlert(deps(), { ...alert(67_500), alertThresholdExceeded: 0.9 });
    expect(await flag()).toBeUndefined();
  });

  it('switches voice off at 100% and logs only the ratio', async () => {
    await handleBudgetAlert(deps(), { ...alert(75_000), alertThresholdExceeded: 1.0 });
    expect(await flag()).toMatchObject({
      disabled: true,
      reason: 'budget',
      period: '2026-10-01T07:00:00Z',
    });
    expect(logs.join('\n')).toContain('voice.disabled_by_budget');
    await handleBudgetAlert(deps(), alert(80_000));
    expect(logs.filter((l) => l.includes('voice.disabled_by_budget'))).toHaveLength(1);
  });

  it('switches voice back on with the first notification of the next billing period', async () => {
    await handleBudgetAlert(deps(), alert(75_000));
    await handleBudgetAlert(deps(), alert(10_000));
    expect((await flag())?.['disabled']).toBe(true);
    await handleBudgetAlert(deps(), alert(0, '2026-11-01T08:00:00Z'));
    expect(await flag()).toMatchObject({ disabled: false, period: '2026-11-01T08:00:00Z' });
  });

  it('never re-enables a manual switch-off', async () => {
    await db.doc(VOICE_FLAG_DOC).set({ disabled: true, reason: 'manual' });
    await handleBudgetAlert(deps(), alert(0, '2026-11-01T08:00:00Z'));
    await handleBudgetAlert(deps(), alert(75_000, '2026-11-01T08:00:00Z'));
    expect(await flag()).toMatchObject({ disabled: true, reason: 'manual' });
  });

  it('is wired as a push handler; malformed notifications are dropped without retry', async () => {
    const app = createApp(async () => deps() as unknown as NotifierDeps);
    const ok = await app.request(BUDGET_ALERT_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        encodePushEnvelope({
          budgetDisplayName: 'ijime-dev-monthly',
          costAmount: 76_000,
          budgetAmount: 75_000,
          costIntervalStart: '2026-10-01T07:00:00Z',
          currencyCode: 'JPY',
        }),
      ),
    });
    expect(ok.status).toBe(204);
    expect((await flag())?.['disabled']).toBe(true);
    const bad = await app.request(BUDGET_ALERT_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(encodePushEnvelope({ costAmount: 1, budgetAmount: 0 })),
    });
    expect(bad.status).toBe(204);
  });
});
