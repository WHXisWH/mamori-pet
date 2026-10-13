import { describe, expect, it, vi } from 'vitest';

import {
  CRISIS_REDELIVERY_PATH,
  crisisRedeliveryRequester,
  withCrisisDelivery,
} from './crisis-publish.js';
import { Logger } from './logger.js';
import { MemoryTaskQueue } from './tasks.js';

const event = { childId: 'c1', crisisId: 'k1', category: 'self_harm', familyHarmSuspected: false };

function harness(
  publishImpl: (topic: string) => Promise<void>,
  redeliverImpl?: () => Promise<void>,
) {
  const lines: string[] = [];
  const publish = vi.fn(publishImpl);
  const redeliver = vi.fn(redeliverImpl ?? (async () => {}));
  const wrapped = withCrisisDelivery(publish, {
    redeliver,
    logger: new Logger('t', (l) => void lines.push(l)),
    timeoutMs: 30,
    attempts: 2,
    retryDelayMs: 1,
  });
  const events = () => lines.map((l) => JSON.parse(l).event as string);
  return { publish, redeliver, wrapped, lines, events };
}

describe('withCrisisDelivery', () => {
  it('leaves other topics untouched, including their errors', async () => {
    const h = harness(async () => {
      throw new Error('down');
    });
    await expect(h.wrapped('message.created', { messageId: 'm' })).rejects.toThrow('down');
    expect(h.publish).toHaveBeenCalledTimes(1);
    expect(h.redeliver).not.toHaveBeenCalled();
  });

  it('publishes a crisis once when Pub/Sub is healthy', async () => {
    const h = harness(async () => {});
    await h.wrapped('crisis.detected', event);
    expect(h.publish).toHaveBeenCalledTimes(1);
    expect(h.redeliver).not.toHaveBeenCalled();
    expect(h.events()).toEqual([]);
  });

  it('retries within the request and stops as soon as one attempt succeeds', async () => {
    let calls = 0;
    const h = harness(async () => {
      if (++calls === 1) throw new Error('blip');
    });
    await h.wrapped('crisis.detected', event);
    expect(h.publish).toHaveBeenCalledTimes(2);
    expect(h.redeliver).not.toHaveBeenCalled();
    expect(h.events()).toEqual(['crisis.publish_attempt_failed']);
  });

  it('never throws on failure: logs an error and hands the event to the redelivery queue', async () => {
    const h = harness(async () => {
      throw new Error('down');
    });
    await expect(h.wrapped('crisis.detected', event)).resolves.toBeUndefined();
    expect(h.publish).toHaveBeenCalledTimes(2);
    expect(h.redeliver).toHaveBeenCalledWith(event);
    expect(h.events()).toEqual([
      'crisis.publish_attempt_failed',
      'crisis.publish_attempt_failed',
      'crisis.publish_failed',
      'crisis.redelivery_queued',
    ]);
  });

  it('bounds a hanging publish by the per-attempt timeout', async () => {
    const h = harness(() => new Promise<void>(() => {}));
    const started = Date.now();
    await h.wrapped('crisis.detected', event);
    expect(Date.now() - started).toBeLessThan(500);
    expect(h.redeliver).toHaveBeenCalledTimes(1);
  });

  it('still returns when the redelivery queue is also down, leaving an error log for alerting', async () => {
    const h = harness(
      async () => {
        throw new Error('down');
      },
      async () => {
        throw new Error('tasks down');
      },
    );
    await expect(h.wrapped('crisis.detected', event)).resolves.toBeUndefined();
    expect(h.events().at(-1)).toBe('crisis.redelivery_enqueue_failed');
  });

  it('logs only the crisis ID', async () => {
    const h = harness(async () => {
      throw new Error('down');
    });
    await h.wrapped('crisis.detected', event);
    for (const line of h.lines) {
      const { crisisId, attempt } = JSON.parse(line);
      expect(crisisId).toBe('k1');
      expect(line).not.toContain('c1');
      expect(attempt === undefined || typeof attempt === 'number').toBe(true);
    }
  });

  it('rejects a malformed crisis payload instead of queueing it', async () => {
    const h = harness(async () => {});
    await expect(h.wrapped('crisis.detected', { crisisId: 'k1', text: 'x' })).rejects.toThrow();
    expect(h.publish).not.toHaveBeenCalled();
  });
});

describe('crisis redelivery task', () => {
  it('goes to signal-worker on the crisis-recheck queue, once per crisis, with only event fields', async () => {
    const queue = new MemoryTaskQueue();
    const request = crisisRedeliveryRequester(queue, 'https://signal.test');
    await request(event as never);
    await request(event as never);
    expect(queue.tasks).toHaveLength(1);
    expect(queue.tasks[0]).toMatchObject({
      queue: 'crisis-recheck',
      url: `https://signal.test${CRISIS_REDELIVERY_PATH}`,
      body: event,
    });
  });
});
