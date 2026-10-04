import { describe, expect, it } from 'vitest';

import { createServiceApp } from './app.js';
import { ApiHttpError } from './errors.js';
import { assertLoggable, ForbiddenLogFieldError, Logger } from './logger.js';

describe('Logger', () => {
  it('writes structured JSON with severity for Cloud Logging', () => {
    const lines: string[] = [];
    const log = new Logger(
      'api',
      (l) => lines.push(l),
      () => '2026-09-29T00:00:00.000Z',
    );
    log.info('turn.receive', { pseudoId: 'p_1', channel: 'text' });
    expect(JSON.parse(lines[0]!)).toEqual({
      severity: 'INFO',
      level: 'info',
      time: '2026-09-29T00:00:00.000Z',
      service: 'api',
      event: 'turn.receive',
      pseudoId: 'p_1',
      channel: 'text',
    });
  });

  it('refuses fields that could carry child input', () => {
    const log = new Logger('api', () => {});
    expect(() => log.info('x', { text: 'きょう…' })).toThrow(ForbiddenLogFieldError);
    expect(() => log.info('x', { nested: { narrative: 'x' } })).toThrow(/nested\.narrative/);
    expect(() => assertLoggable({ transcript: 'x' })).toThrow(ForbiddenLogFieldError);
    expect(() => assertLoggable({ messageId: 'm_1', latencyMs: 3 })).not.toThrow();
  });

  it('serializes errors without stack traces', () => {
    const lines: string[] = [];
    const log = new Logger('api', (l) => lines.push(l));
    log.error('boom', { error: new Error('failed') });
    const entry = JSON.parse(lines[0]!) as { error: { name: string; errorMessage: string } };
    expect(entry.error).toEqual({ name: 'Error', errorMessage: 'failed' });
  });
});

describe('createServiceApp', () => {
  const app = createServiceApp({
    name: 'test',
    version: '1.2.3',
    logger: new Logger('test', () => {}),
  });
  app.get('/boom', () => {
    throw new Error('unexpected');
  });
  app.get('/denied', () => {
    throw new ApiHttpError('PERMISSION_DENIED', '権限がありません');
  });

  it('serves /healthz', async () => {
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', service: 'test', version: '1.2.3' });
    expect(res.headers.get('X-Request-Id')).toMatch(/[0-9a-f-]{36}/);
  });

  it('serves /readyz and reflects readiness', async () => {
    const notReady = createServiceApp({
      name: 'x',
      ready: () => false,
      logger: new Logger('x', () => {}),
    });
    expect((await notReady.request('/readyz')).status).toBe(503);
    expect((await app.request('/readyz')).status).toBe(200);
  });

  it('echoes an incoming request id', async () => {
    const res = await app.request('/healthz', { headers: { 'X-Request-Id': 'req-1' } });
    expect(res.headers.get('X-Request-Id')).toBe('req-1');
  });

  it('formats 404 and API errors per the API doc', async () => {
    const nf = await app.request('/nope');
    expect(nf.status).toBe(404);
    expect(await nf.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    const denied = await app.request('/denied', { headers: { 'X-Request-Id': 'r2' } });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({
      error: { code: 'PERMISSION_DENIED', message: '権限がありません', requestId: 'r2' },
    });
  });

  it('hides internal error details', async () => {
    const res = await app.request('/boom');
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).not.toContain('unexpected');
  });
});
