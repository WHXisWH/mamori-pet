import { describe, expect, it } from 'vitest';

import { createServiceApp } from './app.js';
import { ApiHttpError } from './errors.js';
import { createRateLimiter, createSubjectRateLimit, rateLimitMiddleware } from './rate-limit.js';

const req = () => ({ headers: new Headers() });

describe('createSubjectRateLimit', () => {
  it('limits each subject separately and answers with RATE_LIMITED', () => {
    let at = 0;
    const limit = createSubjectRateLimit({ child: 2, guardian: 1 }, () => at);
    limit.check(req(), 'child', 'c1');
    limit.check(req(), 'child', 'c1');
    limit.check(req(), 'child', 'c2');
    limit.check(req(), 'guardian', 'c1');
    let error: unknown;
    try {
      limit.check(req(), 'child', 'c1');
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ApiHttpError);
    expect((error as ApiHttpError).code).toBe('RATE_LIMITED');
    expect((error as ApiHttpError).message).toContain('困ったときの連絡先');
    expect(() => limit.check(req(), 'guardian', 'g1')).not.toThrow();
    expect(() => limit.check(req(), 'guardian', 'g1')).toThrow(ApiHttpError);

    at = 60_000;
    expect(() => limit.check(req(), 'child', 'c1')).not.toThrow();
  });

  it('counts one request once even when several auth layers check it', () => {
    const limit = createSubjectRateLimit({ child: 1, guardian: 1 });
    const one = req();
    limit.check(one, 'child', 'c1');
    expect(() => limit.check(one, 'child', 'c1')).not.toThrow();
    expect(() => limit.check(req(), 'child', 'c1')).toThrow(ApiHttpError);
  });
});

describe('rateLimitMiddleware', () => {
  it('returns 429 over the limit and skips requests without a key', async () => {
    const app = createServiceApp({ name: 'test', version: '0', ready: async () => true });
    app.use(
      '/v1/*',
      rateLimitMiddleware(
        createRateLimiter(1),
        (c) => (c.req.path === '/v1/help' ? undefined : (c.req.header('X-Subject') ?? 'anon')),
        '少し待ってください',
      ),
    );
    app.get('/v1/*', (c) => c.json({ ok: true }));
    const get = (path: string) => app.request(path, { headers: { 'X-Subject': 's1' } });
    expect((await get('/v1/a')).status).toBe(200);
    const limited = await get('/v1/a');
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { error: { code: string } }).error.code).toBe('RATE_LIMITED');
    expect((await get('/v1/help')).status).toBe(200);
    expect((await get('/v1/help')).status).toBe(200);
  });
});
