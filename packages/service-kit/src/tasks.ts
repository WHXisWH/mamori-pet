import { GoogleHttpError, type GoogleHttp } from './google-http.js';

export type TaskQueueName = 'notify-send' | 'crisis-escalation' | 'consultation-timeout';

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
      });
    } catch (err) {
      if (err instanceof GoogleHttpError && err.status === 409) return;
      throw err;
    }
  }
}
