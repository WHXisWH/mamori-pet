import { randomUUID } from 'node:crypto';

import { Hono } from 'hono';
import type { Context } from 'hono';

import { ApiHttpError, internalErrorBody } from './errors.js';
import { Logger } from './logger.js';

export type ServiceEnv = {
  Variables: { requestId: string; logger: Logger };
};

export type ServiceApp = Hono<ServiceEnv>;

export type CreateServiceAppOptions = {
  name: string;
  version?: string;
  logger?: Logger;
  ready?: () => Promise<boolean> | boolean;
};

export const REQUEST_ID_HEADER = 'X-Request-Id';

export function createServiceApp(opts: CreateServiceAppOptions): ServiceApp {
  const logger = opts.logger ?? new Logger(opts.name);
  const app = new Hono<ServiceEnv>();

  app.use('*', async (c, next) => {
    const requestId = c.req.header(REQUEST_ID_HEADER) ?? randomUUID();
    c.set('requestId', requestId);
    c.set('logger', logger);
    c.header(REQUEST_ID_HEADER, requestId);
    const started = performance.now();
    await next();
    logger.info('http.request', {
      requestId,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      latencyMs: Math.round(performance.now() - started),
    });
  });

  app.get('/healthz', (c) =>
    c.json({ status: 'ok', service: opts.name, version: opts.version ?? '0.0.0' }),
  );

  app.get('/readyz', async (c) => {
    const ok = opts.ready ? await opts.ready() : true;
    return c.json({ status: ok ? 'ok' : 'not_ready', service: opts.name }, ok ? 200 : 503);
  });

  app.notFound((c) => {
    const err = new ApiHttpError('NOT_FOUND', 'リソースが見つかりません');
    return c.json(err.toBody(c.get('requestId')), 404);
  });

  app.onError((err, c) => errorResponse(err, c, logger));

  return app;
}

function errorResponse(err: unknown, c: Context<ServiceEnv>, logger: Logger): Response {
  const requestId = c.get('requestId') ?? 'unknown';
  if (err instanceof ApiHttpError) {
    return c.json(err.toBody(requestId), err.status as 400);
  }
  logger.error('http.unhandled', {
    requestId,
    error: err instanceof Error ? err : new Error(String(err)),
  });
  return c.json(internalErrorBody(requestId), 500);
}
