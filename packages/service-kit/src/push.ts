import type { Context } from 'hono';
import { z } from 'zod';

import type { ServiceApp, ServiceEnv } from './app.js';

const envelopeSchema = z.object({
  message: z.object({
    data: z.string(),
    messageId: z.string().optional(),
    attributes: z.record(z.string(), z.string()).optional(),
  }),
  subscription: z.string().optional(),
});

export type PushParseResult<T> = { ok: true; data: T; messageId?: string } | { ok: false };

export function parsePushEnvelope<T>(body: unknown, schema: z.ZodType<T>): PushParseResult<T> {
  const env = envelopeSchema.safeParse(body);
  if (!env.success) return { ok: false };
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(env.data.message.data, 'base64').toString('utf8'));
  } catch {
    return { ok: false };
  }
  const parsed = schema.safeParse(decoded);
  if (!parsed.success) return { ok: false };
  const out: PushParseResult<T> = { ok: true, data: parsed.data };
  if (env.data.message.messageId) out.messageId = env.data.message.messageId;
  return out;
}

export function encodePushEnvelope(payload: unknown, messageId = 'test'): unknown {
  return {
    message: { data: Buffer.from(JSON.stringify(payload)).toString('base64'), messageId },
    subscription: 'projects/demo/subscriptions/test',
  };
}

// 処理は終わったがリトライすべきでない場合（元データが削除済み、条件を満たさないなど）
export class SkipEvent extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'SkipEvent';
  }
}

type Handler<T> = (data: T, c: Context<ServiceEnv>) => Promise<void>;

// 204 は処理済みまたはリトライ不要を表す。503 は Pub/Sub / Cloud Tasks のリトライに任せる
function register<T>(
  app: ServiceApp,
  kind: 'push' | 'task',
  path: string,
  parse: (body: unknown) => { ok: true; data: T } | { ok: false },
  handler: Handler<T>,
): void {
  app.post(path, async (c) => {
    const log = c.get('logger');
    const parsed = parse(await c.req.json().catch(() => null));
    if (!parsed.ok) {
      log.warn(`${kind}.invalid_payload`, { path });
      return c.body(null, 204);
    }
    try {
      await handler(parsed.data, c);
      return c.body(null, 204);
    } catch (err) {
      if (err instanceof SkipEvent) {
        log.info(`${kind}.skipped`, { path, reason: err.reason });
        return c.body(null, 204);
      }
      log.error(`${kind}.failed`, {
        path,
        error: err instanceof Error ? err : new Error('unknown'),
      });
      return c.body(null, 503);
    }
  });
}

export function registerPushHandler<T>(
  app: ServiceApp,
  path: string,
  schema: z.ZodType<T>,
  handler: Handler<T>,
): void {
  register(app, 'push', path, (b) => parsePushEnvelope(b, schema), handler);
}

export function registerTaskHandler<T>(
  app: ServiceApp,
  path: string,
  schema: z.ZodType<T>,
  handler: Handler<T>,
): void {
  register(
    app,
    'task',
    path,
    (b) => {
      const r = schema.safeParse(b);
      return r.success ? { ok: true, data: r.data } : { ok: false };
    },
    handler,
  );
}
