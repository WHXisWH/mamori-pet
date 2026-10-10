import { Firestore } from '@google-cloud/firestore';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MemoryTaskQueue } from '@ijime/service-kit';

import { createApp } from './app.js';

let db: Firestore;
let queue: MemoryTaskQueue;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  if (!process.env['FIRESTORE_EMULATOR_HOST']) throw new Error('needs Firestore emulator');
  db = new Firestore({ projectId: `demo-proactive-${Date.now()}` });
  queue = new MemoryTaskQueue();
  await db.doc('families/f_proactive/children/c_active').set({
    childId: 'c_active',
    familyId: 'f_proactive',
    status: 'active',
  });
  await db.doc('families/f_proactive/children/c_disabled').set({
    childId: 'c_disabled',
    familyId: 'f_proactive',
    status: 'active',
    proactiveEnabled: false,
  });
  app = createApp({
    getKb: async () => {
      throw new Error('unused');
    },
    allowedOrigins: [],
    proactive: async () => ({
      db,
      queue,
      petAgentUrl: 'http://pet-agent.test',
      dispatchToken: 'test-token',
      now: () => new Date('2026-10-05T00:00:00Z'),
    }),
  });
});

afterAll(() => db.terminate());

describe('proactive turn dispatch', () => {
  it('rejects requests without the internal token', async () => {
    const response = await app.request('/internal/proactive-turns/dispatch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slot: 'morning' }),
    });
    expect(response.status).toBe(401);
  });

  it('enqueues active children and skips disabled children', async () => {
    const response = await app.request('/internal/proactive-turns/dispatch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Token': 'test-token' },
      body: JSON.stringify({ slot: 'morning' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      slot: 'morning',
      localDate: '2026-10-05',
      queued: 1,
      skipped: 1,
    });
    expect(queue.take('proactive-turns')).toEqual([
      {
        queue: 'proactive-turns',
        url: 'http://pet-agent.test/internal/proactive-turns',
        body: { childId: 'c_active', slot: 'morning', localDate: '2026-10-05' },
        taskId: expect.stringMatching(/^proactive-/),
      },
    ]);
  });
});
