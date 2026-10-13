import { crisis as crisisConfig, outbound } from '@ijime/config';
import { z } from 'zod';

import { AdcGoogleHttp, GoogleHttpError, type GoogleHttp } from './google-http.js';
import { stableId } from './ids.js';

export type TaskQueueName =
  | 'notify-send'
  | 'crisis-escalation'
  | 'consultation-timeout'
  | 'crisis-recheck'
  | 'weekly-report'
  | 'proactive-turns';

export type TaskSpec = {
  queue: TaskQueueName;
  url: string;
  body: Record<string, unknown>;
  delaySeconds?: number;
  // 同じ名前のタスクは1回しか作成されない。冪等性のために使う
  taskId?: string;
};

export interface TaskQueue {
  enqueue(spec: TaskSpec): Promise<void>;
}

export class MemoryTaskQueue implements TaskQueue {
  readonly tasks: TaskSpec[] = [];
  private readonly ids = new Set<string>();

  async enqueue(spec: TaskSpec): Promise<void> {
    if (spec.taskId) {
      const key = `${spec.queue}/${spec.taskId}`;
      if (this.ids.has(key)) return;
      this.ids.add(key);
    }
    this.tasks.push(spec);
  }

  take(queue: TaskQueueName): TaskSpec[] {
    const out = this.tasks.filter((t) => t.queue === queue);
    for (const t of out) this.tasks.splice(this.tasks.indexOf(t), 1);
    return out;
  }
}

export class CloudTasksRestQueue implements TaskQueue {
  constructor(
    private readonly opts: {
      projectId: string;
      location: string;
      invokerServiceAccount: string;
      audience: string;
      http: GoogleHttp;
      now?: () => number;
    },
  ) {}

  async enqueue(spec: TaskSpec): Promise<void> {
    const { projectId, location } = this.opts;
    const parent = `projects/${projectId}/locations/${location}/queues/${spec.queue}`;
    const now = this.opts.now ?? Date.now;
    const task: Record<string, unknown> = {
      httpRequest: {
        httpMethod: 'POST',
        url: spec.url,
        headers: { 'Content-Type': 'application/json' },
        body: Buffer.from(JSON.stringify(spec.body)).toString('base64'),
        oidcToken: {
          serviceAccountEmail: this.opts.invokerServiceAccount,
          audience: this.opts.audience,
        },
      },
    };
    if (spec.taskId) task['name'] = `${parent}/tasks/${spec.taskId}`;
    if (spec.delaySeconds)
      task['scheduleTime'] = new Date(now() + spec.delaySeconds * 1000).toISOString();
    try {
      await this.opts.http.request({
        url: `https://cloudtasks.googleapis.com/v2/${parent}/tasks`,
        method: 'POST',
        body: { task },
        timeoutMs: outbound.googleApiTimeoutMs,
      });
    } catch (err) {
      if (err instanceof GoogleHttpError && err.status === 409) return;
      throw err;
    }
  }
}

// モデルが利用できないときに保留した子どものメッセージ。signal-worker があとから危機検知をやり直す（docs/02「危機検知器」モデルが利用できないときの処理 第2項）。
// タスクには ID だけを入れ、子どもの入力は含めない。
export const CRISIS_RECHECK_PATH = '/internal/tasks/crisis-recheck';

const recheckId = z.string().min(1).max(128);
export const crisisRecheckTaskSchema = z.strictObject({
  familyId: recheckId,
  childId: recheckId,
  sessionId: recheckId,
  messageId: recheckId,
  channel: z.enum(['text', 'voice']),
});
export type CrisisRecheckTask = z.infer<typeof crisisRecheckTaskSchema>;

export function crisisRecheckSpec(signalWorkerUrl: string, task: CrisisRecheckTask): TaskSpec {
  return {
    queue: 'crisis-recheck',
    url: `${signalWorkerUrl}${CRISIS_RECHECK_PATH}`,
    body: task,
    delaySeconds: crisisConfig.recheckDelaySeconds,
    taskId: `recheck-${stableId(task.childId, task.sessionId, task.messageId)}`,
  };
}

export type CrisisRecheckRequester = (task: CrisisRecheckTask) => Promise<void>;

export function crisisRecheckRequester(
  queue: TaskQueue,
  signalWorkerUrl: string,
): CrisisRecheckRequester {
  return (task) => queue.enqueue(crisisRecheckSpec(signalWorkerUrl, task));
}

// ローカル開発ではメモリ上のキューを使う（タスクは実行されない）。本番は Cloud Tasks を使い、sa-tasks の身元で signal-worker を呼び出す
export function signalWorkerQueueFromEnv(opts: {
  prod: boolean;
  projectId: string | undefined;
  location: string;
}): { queue: TaskQueue; url: string } {
  if (!opts.prod)
    return {
      queue: new MemoryTaskQueue(),
      url: process.env['SIGNAL_WORKER_URL'] ?? 'http://localhost:8084',
    };
  const url = process.env['SIGNAL_WORKER_URL'];
  const invoker = process.env['TASKS_INVOKER_SA'];
  if (!url || !invoker || !opts.projectId)
    throw new Error('missing env SIGNAL_WORKER_URL / TASKS_INVOKER_SA / GCP_PROJECT_ID');
  return {
    queue: new CloudTasksRestQueue({
      projectId: opts.projectId,
      location: opts.location,
      invokerServiceAccount: invoker,
      audience: url,
      http: new AdcGoogleHttp(),
    }),
    url,
  };
}

export function crisisRecheckRequesterFromEnv(opts: {
  prod: boolean;
  projectId: string | undefined;
  location: string;
}): CrisisRecheckRequester {
  const { queue, url } = signalWorkerQueueFromEnv(opts);
  return crisisRecheckRequester(queue, url);
}

// 予定した自発ターンは子どもの ID と日付だけを渡し、子どもの内容を Cloud Tasks に入れない。
export const PROACTIVE_TURNS_PATH = '/internal/proactive-turns';

const proactiveId = z.string().min(1).max(128);
export const proactiveTurnTaskSchema = z.strictObject({
  childId: proactiveId,
  slot: z.enum(['morning', 'after_school', 'bedtime']),
  localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export type ProactiveTurnTask = z.infer<typeof proactiveTurnTaskSchema>;

export function proactiveTurnSpec(petAgentUrl: string, task: ProactiveTurnTask): TaskSpec {
  return {
    queue: 'proactive-turns',
    url: `${petAgentUrl}${PROACTIVE_TURNS_PATH}`,
    body: task,
    taskId: `proactive-${stableId(task.childId, task.localDate, task.slot)}`,
  };
}
