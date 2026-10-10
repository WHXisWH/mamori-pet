import { crisis as crisisConfig } from '@ijime/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CRISIS_RECHECK_PATH,
  crisisRecheckRequester,
  crisisRecheckRequesterFromEnv,
  crisisRecheckSpec,
  crisisRecheckTaskSchema,
  MemoryTaskQueue,
  PROACTIVE_TURNS_PATH,
  proactiveTurnSpec,
  proactiveTurnTaskSchema,
} from './tasks.js';

const TASK = {
  familyId: 'f1',
  childId: 'c1',
  sessionId: 's1',
  messageId: 'm1',
  channel: 'text' as const,
};

afterEach(() => vi.unstubAllEnvs());

describe('crisis recheck task', () => {
  it('targets signal-worker after the configured delay with a stable task ID', () => {
    const spec = crisisRecheckSpec('https://sw.example', TASK);
    expect(spec).toMatchObject({
      queue: 'crisis-recheck',
      url: `https://sw.example${CRISIS_RECHECK_PATH}`,
      body: TASK,
      delaySeconds: crisisConfig.recheckDelaySeconds,
    });
    expect(spec.taskId).toBe(crisisRecheckSpec('https://other', TASK).taskId);
    expect(spec.taskId).not.toBe(
      crisisRecheckSpec('https://sw.example', { ...TASK, messageId: 'm2' }).taskId,
    );
  });

  it('carries IDs only: extra fields such as text are rejected', () => {
    expect(crisisRecheckTaskSchema.safeParse(TASK).success).toBe(true);
    expect(crisisRecheckTaskSchema.safeParse({ ...TASK, text: 'x' }).success).toBe(false);
    expect(crisisRecheckTaskSchema.safeParse({ ...TASK, channel: 'artwork' }).success).toBe(false);
  });

  it('enqueues once per message even if requested twice', async () => {
    const queue = new MemoryTaskQueue();
    const request = crisisRecheckRequester(queue, 'https://sw.example');
    await request(TASK);
    await request(TASK);
    expect(queue.take('crisis-recheck')).toHaveLength(1);
  });

  it('production requires the worker URL and the invoker service account', () => {
    vi.stubEnv('SIGNAL_WORKER_URL', '');
    vi.stubEnv('TASKS_INVOKER_SA', 'sa-tasks@p.iam.gserviceaccount.com');
    expect(() =>
      crisisRecheckRequesterFromEnv({ prod: true, projectId: 'p', location: 'asia-northeast1' }),
    ).toThrow('SIGNAL_WORKER_URL');
    vi.stubEnv('SIGNAL_WORKER_URL', 'https://sw.example');
    vi.stubEnv('TASKS_INVOKER_SA', '');
    expect(() =>
      crisisRecheckRequesterFromEnv({ prod: true, projectId: 'p', location: 'asia-northeast1' }),
    ).toThrow('TASKS_INVOKER_SA');
    vi.stubEnv('TASKS_INVOKER_SA', 'sa-tasks@p.iam.gserviceaccount.com');
    expect(
      typeof crisisRecheckRequesterFromEnv({
        prod: true,
        projectId: 'p',
        location: 'asia-northeast1',
      }),
    ).toBe('function');
  });

  it('outside production it never calls Cloud Tasks', async () => {
    vi.stubEnv('SIGNAL_WORKER_URL', '');
    const request = crisisRecheckRequesterFromEnv({
      prod: false,
      projectId: undefined,
      location: 'asia-northeast1',
    });
    await expect(request(TASK)).resolves.toBeUndefined();
  });
});

describe('proactive turn task', () => {
  it('carries only the child/date/slot and deduplicates the same scheduled turn', () => {
    const task = { childId: 'c1', slot: 'morning' as const, localDate: '2026-10-05' };
    const spec = proactiveTurnSpec('https://pet.example', task);
    expect(spec).toMatchObject({
      queue: 'proactive-turns',
      url: `https://pet.example${PROACTIVE_TURNS_PATH}`,
      body: task,
    });
    expect(spec.taskId).toBe(proactiveTurnSpec('https://other', task).taskId);
    expect(proactiveTurnTaskSchema.safeParse(task).success).toBe(true);
    expect(proactiveTurnTaskSchema.safeParse({ ...task, text: 'private' }).success).toBe(false);
  });
});
