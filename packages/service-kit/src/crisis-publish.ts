import { crisis as crisisConfig } from '@ijime/config';
import type { z } from 'zod';

import { eventSchemas } from './events.js';
import { stableId } from './ids.js';
import type { Logger } from './logger.js';
import { signalWorkerQueueFromEnv, type TaskQueue, type TaskSpec } from './tasks.js';

// crisis.detected の発行で子どもへの相談窓口の案内を止めてはならず、失敗したときに保護者への通知を黙って失ってもならない（2026-10-12 決定）。
// リクエスト内では回数を限って再試行し、それでも失敗したらエラーログを出して Cloud Tasks に渡し、signal-worker が再送する。キューは届くまでバックオフして再試行する。
// タスクに入るのはイベント自体の ID と列挙値だけで、子どもの入力は含まない。
export const CRISIS_REDELIVERY_PATH = '/internal/tasks/crisis-redelivery';
export const crisisRedeliveryTaskSchema = eventSchemas['crisis.detected'];
export type CrisisRedeliveryTask = z.infer<typeof crisisRedeliveryTaskSchema>;
export type CrisisRedeliveryRequester = (task: CrisisRedeliveryTask) => Promise<void>;

export function crisisRedeliverySpec(
  signalWorkerUrl: string,
  task: CrisisRedeliveryTask,
): TaskSpec {
  return {
    queue: 'crisis-recheck',
    url: `${signalWorkerUrl}${CRISIS_REDELIVERY_PATH}`,
    body: task,
    delaySeconds: crisisConfig.redeliveryDelaySeconds,
    taskId: `crisis-publish-${stableId(task.childId, task.crisisId)}`,
  };
}

export function crisisRedeliveryRequester(
  queue: TaskQueue,
  signalWorkerUrl: string,
): CrisisRedeliveryRequester {
  return (task) => queue.enqueue(crisisRedeliverySpec(signalWorkerUrl, task));
}

export function crisisRedeliveryRequesterFromEnv(opts: {
  prod: boolean;
  projectId: string | undefined;
  location: string;
}): CrisisRedeliveryRequester {
  const { queue, url } = signalWorkerQueueFromEnv(opts);
  return crisisRedeliveryRequester(queue, url);
}

export type CrisisDeliveryOptions = {
  redeliver: CrisisRedeliveryRequester;
  logger: Logger;
  timeoutMs?: number;
  attempts?: number;
  retryDelayMs?: number;
};

function within<T>(ms: number, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('crisis_publish_timeout')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// サービスの publish を包む。変わるのは crisis.detected の挙動だけで、決して例外を投げないため、呼び出し側はそのまま子どもに相談窓口を案内できる
export function withCrisisDelivery<T extends string>(
  publish: (topic: T, payload: Record<string, unknown>) => Promise<void>,
  opts: CrisisDeliveryOptions,
): (topic: T, payload: Record<string, unknown>) => Promise<void> {
  const timeoutMs = opts.timeoutMs ?? crisisConfig.publishTimeoutMs;
  const attempts = opts.attempts ?? crisisConfig.publishAttempts;
  const retryDelayMs = opts.retryDelayMs ?? crisisConfig.publishRetryDelayMs;
  return async (topic, payload) => {
    if (topic !== 'crisis.detected') return publish(topic, payload);
    const task = crisisRedeliveryTaskSchema.parse(payload);
    const ids = { crisisId: task.crisisId };
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await within(timeoutMs, publish(topic, payload));
        return;
      } catch {
        opts.logger.warn('crisis.publish_attempt_failed', { ...ids, attempt });
        if (attempt < attempts) await new Promise((r) => setTimeout(r, retryDelayMs));
      }
    }
    opts.logger.error('crisis.publish_failed', ids);
    try {
      await within(timeoutMs, opts.redeliver(task));
      opts.logger.warn('crisis.redelivery_queued', ids);
    } catch {
      // 既知の残存リスク：発行とキューへの投入の両方に失敗したときは、アラートの手がかりがこのエラーログだけになる
      opts.logger.error('crisis.redelivery_enqueue_failed', ids);
    }
  };
}
