import { outbound } from '@ijime/config';
import { describe, expect, it } from 'vitest';

import { createServiceApp } from './app.js';
import { eventSchemas } from './events.js';
import { GoogleHttpError, PlainHttp, type GoogleHttp, type GoogleRequest } from './google-http.js';
import { stableId } from './ids.js';
import { Logger } from './logger.js';
import { MemoryPublisher, PubSubRestPublisher, topicResourceName } from './publisher.js';
import { encodePushEnvelope, parsePushEnvelope, registerPushHandler, SkipEvent } from './push.js';
import { CloudTasksRestQueue, MemoryTaskQueue } from './tasks.js';

class RecordingHttp implements GoogleHttp {
  readonly calls: GoogleRequest[] = [];
  constructor(private readonly respond: (r: GoogleRequest) => unknown = () => ({})) {}
  async request<T>(req: GoogleRequest): Promise<T> {
    this.calls.push(req);
    return this.respond(req) as T;
  }
}

describe('stableId', () => {
  it('is deterministic and separates parts', () => {
    expect(stableId('a', 'b')).toBe(stableId('a', 'b'));
    expect(stableId('ab', 'c')).not.toBe(stableId('a', 'bc'));
    expect(stableId('x', 1)).toMatch(/^[0-9a-f]{24}$/);
  });
});

describe('event schemas', () => {
  it('reject any extra field so child text cannot ride along', () => {
    const ok = { childId: 'c1', crisisId: 'k1', familyHarmSuspected: false };
    expect(eventSchemas['crisis.detected'].safeParse(ok).success).toBe(true);
    expect(eventSchemas['crisis.detected'].safeParse({ ...ok, text: '死にたい' }).success).toBe(
      false,
    );
  });
});

describe('parsePushEnvelope', () => {
  const schema = eventSchemas['message.created'];
  const payload = {
    familyId: 'f1',
    childId: 'c1',
    sessionId: 's1',
    messageId: 'm1',
    channel: 'text' as const,
  };

  it('decodes a valid envelope', () => {
    const r = parsePushEnvelope(encodePushEnvelope(payload, 'pm1'), schema);
    expect(r).toEqual({ ok: true, data: payload, messageId: 'pm1' });
  });

  it('rejects broken base64 JSON, bad shape, and extra fields', () => {
    expect(parsePushEnvelope({ message: { data: '!!!' } }, schema).ok).toBe(false);
    expect(parsePushEnvelope({ nope: 1 }, schema).ok).toBe(false);
    expect(parsePushEnvelope(encodePushEnvelope({ ...payload, text: 'x' }), schema).ok).toBe(false);
  });
});

describe('registerPushHandler', () => {
  function setup(handler: () => Promise<void>) {
    const lines: string[] = [];
    const app = createServiceApp({ name: 't', logger: new Logger('t', (l) => lines.push(l)) });
    registerPushHandler(app, '/e', eventSchemas['crisis.detected'], handler);
    const post = (body: unknown) =>
      app.request('/e', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
      });
    return { post, lines };
  }
  const good = encodePushEnvelope({ childId: 'c', crisisId: 'k', familyHarmSuspected: true });

  it('acks success, invalid payloads, and skips; nacks failures for retry', async () => {
    expect((await setup(async () => {}).post(good)).status).toBe(204);
    expect((await setup(async () => {}).post({ bad: true })).status).toBe(204);
    const skip = setup(async () => {
      throw new SkipEvent('gone');
    });
    expect((await skip.post(good)).status).toBe(204);
    expect((await setup(async () => Promise.reject(new Error('db'))).post(good)).status).toBe(503);
  });
});

describe('publishers', () => {
  it('MemoryPublisher validates payloads', async () => {
    const p = new MemoryPublisher();
    await p.publish('crisis.detected', { childId: 'c', crisisId: 'k', familyHarmSuspected: false });
    expect(p.of('crisis.detected')).toHaveLength(1);
    await expect(
      p.publish('crisis.detected', {
        childId: 'c',
        crisisId: 'k',
        familyHarmSuspected: false,
        text: 'x',
      } as never),
    ).rejects.toThrow();
  });

  it('PubSubRestPublisher posts base64 data to the hyphenated topic', async () => {
    const http = new RecordingHttp();
    const p = new PubSubRestPublisher('proj', http);
    await p.publish('risk.level_changed', {
      childId: 'c',
      assessmentId: 'a',
      from: 'l1',
      to: 'l2',
    });
    const call = http.calls[0]!;
    expect(call.url).toBe(
      'https://pubsub.googleapis.com/v1/projects/proj/topics/risk-level_changed:publish',
    );
    const data = (call.body as { messages: { data: string }[] }).messages[0]!.data;
    expect(JSON.parse(Buffer.from(data, 'base64').toString())).toMatchObject({ to: 'l2' });
    expect(topicResourceName('crisis.detected')).toBe('crisis-detected');
    // 危機対応経路での外部への呼び出しには制限時間が必要。止まったリクエスト1つでいつまでも待たされてはならない
    expect(call.timeoutMs).toBe(outbound.googleApiTimeoutMs);
  });
});

describe('task queues', () => {
  it('MemoryTaskQueue dedupes by task id', async () => {
    const q = new MemoryTaskQueue();
    const spec = { queue: 'notify-send' as const, url: 'http://n/x', body: {}, taskId: 't1' };
    await q.enqueue(spec);
    await q.enqueue(spec);
    expect(q.take('notify-send')).toHaveLength(1);
    expect(q.tasks).toHaveLength(0);
  });

  it('CloudTasksRestQueue builds an OIDC task and treats 409 as done', async () => {
    const http = new RecordingHttp();
    const q = new CloudTasksRestQueue({
      projectId: 'p',
      location: 'asia-northeast1',
      invokerServiceAccount: 'inv@p.iam.gserviceaccount.com',
      audience: 'https://notifier',
      http,
      now: () => Date.parse('2026-10-01T00:00:00Z'),
    });
    await q.enqueue({
      queue: 'crisis-escalation',
      url: 'https://notifier/internal/tasks/escalate',
      body: { crisisId: 'k' },
      delaySeconds: 600,
      taskId: 'esc-k',
    });
    const task = (http.calls[0]!.body as { task: Record<string, unknown> }).task;
    expect(task['name']).toBe(
      'projects/p/locations/asia-northeast1/queues/crisis-escalation/tasks/esc-k',
    );
    expect(task['scheduleTime']).toBe('2026-10-01T00:10:00.000Z');
    expect(http.calls[0]!.timeoutMs).toBe(outbound.googleApiTimeoutMs);
    expect(task['httpRequest']).toMatchObject({
      oidcToken: {
        serviceAccountEmail: 'inv@p.iam.gserviceaccount.com',
        audience: 'https://notifier',
      },
    });

    const conflict = new CloudTasksRestQueue({
      projectId: 'p',
      location: 'l',
      invokerServiceAccount: 's',
      audience: 'a',
      http: new RecordingHttp(() => {
        throw new GoogleHttpError(409, 'exists');
      }),
    });
    await expect(
      conflict.enqueue({ queue: 'notify-send', url: 'u', body: {}, taskId: 'x' }),
    ).resolves.toBeUndefined();
  });
});

describe('PlainHttp', () => {
  it('aborts a request that exceeds its timeout', async () => {
    const hanging = (async (_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)),
      )) as unknown as typeof fetch;
    const started = Date.now();
    await expect(
      new PlainHttp(hanging).request({ url: 'http://x', method: 'POST', timeoutMs: 20 }),
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
