import { createServiceApp, createSubjectRateLimit, type ServiceEnv } from '@ijime/service-kit';
import type { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import {
  accountIdentity,
  childAuth,
  guardianAuth,
  unthrottledChildRoute,
  type AuthEnv,
  type AuthOptions,
  type GuardianAuthEnv,
} from './auth.js';

function testApp(opts: AuthOptions) {
  const app = createServiceApp({ name: 'api', version: '0', ready: async () => true });
  const child = app as unknown as Hono<AuthEnv & ServiceEnv>;
  // 実際のルートと同じく、外側と内側で childAuth を1回ずつ通す
  child.use('/v1/child/*', childAuth(opts));
  child.use('/v1/child/chat/*', childAuth(opts));
  child.get('/v1/child/profile', (c) => c.json({ ok: true }));
  child.get('/v1/child/chat/sessions', (c) => c.json({ ok: true }));
  child.post('/v1/child/chat/sessions/:id/messages', (c) => c.json({ ok: true }));
  child.post('/v1/child/tell-adult', (c) => c.json({ ok: true }));
  const guardian = app as unknown as Hono<GuardianAuthEnv & ServiceEnv>;
  guardian.use(
    '/v1/notifications',
    guardianAuth(opts, async () => 'f1'),
  );
  guardian.get('/v1/notifications', (c) => c.json({ ok: true }));
  app.get('/v1/me', async (c) => {
    await accountIdentity(c.req.raw.headers, opts);
    return c.json({ ok: true });
  });
  return app;
}

const opts = (): AuthOptions => ({
  allowDevHeader: true,
  rateLimit: createSubjectRateLimit({ child: 2, guardian: 2 }),
});

const asChild = (id: string) => ({ headers: { 'X-Dev-Child-Id': id } });
const asGuardian = (id: string) => ({ headers: { 'X-Dev-Guardian-Id': id } });

describe('per-subject rate limit', () => {
  it('limits a child across endpoints and counts nested auth once', async () => {
    const app = testApp(opts());
    expect((await app.request('/v1/child/chat/sessions', asChild('c1'))).status).toBe(200);
    expect((await app.request('/v1/child/profile', asChild('c1'))).status).toBe(200);
    const limited = await app.request('/v1/child/profile', asChild('c1'));
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { error: { code: string } }).error.code).toBe('RATE_LIMITED');
    expect((await app.request('/v1/child/profile', asChild('c2'))).status).toBe(200);
  });

  it('never blocks asking an adult or crisis-checked messages', async () => {
    const app = testApp(opts());
    for (let i = 0; i < 3; i++) await app.request('/v1/child/profile', asChild('c1'));
    const post = (path: string) => app.request(path, { method: 'POST', ...asChild('c1') });
    expect((await post('/v1/child/tell-adult')).status).toBe(200);
    expect((await post('/v1/child/chat/sessions/s1/messages')).status).toBe(200);
  });

  it('limits a guardian across guardianAuth and accountIdentity routes', async () => {
    const app = testApp(opts());
    expect((await app.request('/v1/notifications', asGuardian('g1'))).status).toBe(200);
    expect((await app.request('/v1/me', asGuardian('g1'))).status).toBe(200);
    expect((await app.request('/v1/me', asGuardian('g1'))).status).toBe(429);
    expect((await app.request('/v1/notifications', asGuardian('g2'))).status).toBe(200);
  });

  it('does not count requests that fail authentication', async () => {
    const app = testApp(opts());
    for (let i = 0; i < 3; i++) expect((await app.request('/v1/child/profile')).status).toBe(401);
    expect((await app.request('/v1/child/profile', asChild('c1'))).status).toBe(200);
  });

  it('every exempt pattern matches a registered route', () => {
    const never = async (): Promise<never> => {
      throw new Error('not used');
    };
    const app = createApp({
      getKb: never,
      allowedOrigins: [],
      chat: never,
      accounts: never,
      guardian: never,
      submissions: never,
    });
    const routes = app.routes.map((r) => ({
      method: r.method,
      path: r.path.replace(/:[^/]+/g, 'x'),
    }));
    for (const [method, path] of [
      ['POST', '/v1/child/tell-adult'],
      ['POST', '/v1/child/chat/sessions/x/messages'],
      ['POST', '/v1/child/consultations/x/choice'],
      ['PUT', '/v1/child/island'],
      ['POST', '/v1/child/island-scenes'],
      ['POST', '/v1/child/artworks'],
      ['POST', '/v1/child/pet-requests/x/complete'],
    ] as const) {
      expect(unthrottledChildRoute(method, path), path).toBe(true);
      expect(
        routes.some((r) => r.method === method && r.path === path),
        path,
      ).toBe(true);
    }
    expect(unthrottledChildRoute('GET', '/v1/child/profile')).toBe(false);
  });
});
