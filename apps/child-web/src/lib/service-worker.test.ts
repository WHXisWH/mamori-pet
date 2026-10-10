// @vitest-environment node

import { readFileSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8');
const origin = 'https://child.test';

type WorkerEvent = {
  request?: Request;
  respondWith: ReturnType<typeof vi.fn<(response: Promise<Response>) => void>>;
  waitUntil: ReturnType<typeof vi.fn<(work: Promise<unknown>) => void>>;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function request(path: string, init?: RequestInit, navigate = false) {
  const result = new Request(new URL(path, origin), init);
  if (navigate) Object.defineProperty(result, 'mode', { value: 'navigate' });
  return result;
}

function html(body = '<html>offline help</html>') {
  return new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function worker() {
  const listeners = new Map<string, (event: WorkerEvent) => void>();
  const entries = new Map<string, Response>();
  const key = (input: Request | string) =>
    new URL(typeof input === 'string' ? input : input.url, origin).href;
  const match = vi.fn(async (input: Request | string, options?: CacheQueryOptions) => {
    const url = key(input);
    const entry = [...entries].find(([stored]) =>
      options?.ignoreSearch ? stored.split('?')[0] === url.split('?')[0] : stored === url,
    );
    return entry?.[1].clone();
  });
  const cache = {
    match,
    put: vi.fn(async (input: Request | string, response: Response) => {
      entries.set(key(input), new Response(await response.arrayBuffer(), response));
    }),
    addAll: vi.fn(async (_paths: string[]) => {}),
  };
  const caches = {
    open: vi.fn(async (_name: string) => cache),
    match,
    keys: vi.fn(async () => ['shell-v1', 'api-v1', 'shell-v2', 'api-v2', 'shell-v3', 'api-v3']),
    delete: vi.fn(async (_name: string) => true),
  };
  const fetch = vi.fn(async (_request: Request) => html());
  const self = {
    location: new URL(origin),
    addEventListener: (name: string, listener: (event: WorkerEvent) => void) =>
      listeners.set(name, listener),
    skipWaiting: vi.fn(async () => {}),
    clients: { claim: vi.fn(async () => {}) },
  };
  runInNewContext(source, { self, caches, fetch, URL, Response });

  function dispatch(name: string, input?: Request) {
    const work: Promise<unknown>[] = [];
    let response: Promise<Response> | undefined;
    const event: WorkerEvent = {
      ...(input ? { request: input } : {}),
      respondWith: vi.fn((value) => {
        response = Promise.resolve(value);
      }),
      waitUntil: vi.fn((value) => {
        work.push(value);
      }),
    };
    listeners.get(name)!(event);
    return { event, response, done: () => Promise.all(work) };
  }

  return { cache, caches, fetch, self, dispatch };
}

describe('service worker offline cache', () => {
  const routes = [
    { path: '/_next/static/chunk.js', navigate: false, cacheName: 'shell-v3' },
    { path: '/help', navigate: true, cacheName: 'shell-v3' },
    { path: 'https://api.test/v1/child/help-resources', navigate: false, cacheName: 'api-v3' },
    { path: '/reading-worker.js', navigate: false, cacheName: 'shell-v3' },
    { path: '/readings/kuromoji-0.1.2/dict/tid.dat.gz', navigate: false, cacheName: 'shell-v3' },
  ];

  it.each(routes)(
    'clones $path before consumption while cache opening is delayed',
    async (route) => {
      const sw = worker();
      const opening = deferred<typeof sw.cache>();
      const network = html();
      sw.caches.open.mockReturnValue(opening.promise);
      sw.fetch.mockResolvedValue(network);

      const event = sw.dispatch('fetch', request(route.path, undefined, route.navigate));
      const response = await event.response;
      expect(response).toBe(network);
      expect(await response!.text()).toBe('<html>offline help</html>');
      expect(network.bodyUsed).toBe(true);
      expect(sw.cache.put).not.toHaveBeenCalled();

      opening.resolve(sw.cache);
      await setImmediate();
      await event.done();
      expect(sw.cache.put).toHaveBeenCalledOnce();
      expect(sw.caches.open).toHaveBeenCalledWith(route.cacheName);
      expect(await (await sw.cache.match(route.path))?.text()).toBe('<html>offline help</html>');
      expect(event.event.waitUntil).toHaveBeenCalled();
    },
  );

  it.each(routes)('keeps the event alive until the $path cache write completes', async (route) => {
    const sw = worker();
    const writing = deferred<void>();
    sw.cache.put.mockReturnValue(writing.promise);
    const event = sw.dispatch('fetch', request(route.path, undefined, route.navigate));
    expect(await (await event.response)!.text()).toBe('<html>offline help</html>');
    expect(event.event.waitUntil).toHaveBeenCalled();
    let finished = false;
    const completion = event.done().then(() => {
      finished = true;
    });
    await setImmediate();
    expect(finished).toBe(false);
    writing.resolve();
    await completion;
    expect(finished).toBe(true);
  });

  describe.each(routes)('$path cache failures', (route) => {
    it.each(['open', 'put'] as const)(
      'preserves network success when %s rejects',
      async (operation) => {
        const sw = worker();
        const network = html();
        sw.fetch.mockResolvedValue(network);
        const failure = new Error('storage unavailable');
        if (operation === 'open') sw.caches.open.mockRejectedValue(failure);
        else sw.cache.put.mockRejectedValue(failure);
        const event = sw.dispatch('fetch', request(route.path, undefined, route.navigate));

        expect(await event.response).toBe(network);
        expect(await network.text()).toBe('<html>offline help</html>');
        expect(event.event.waitUntil).toHaveBeenCalled();
        await expect(event.done()).resolves.toBeDefined();
      },
    );
  });

  it('fetches static assets even when the cache lookup rejects', async () => {
    const sw = worker();
    sw.caches.match.mockRejectedValue(new Error('storage unavailable'));
    const event = sw.dispatch('fetch', request('/_next/static/chunk.js'));
    expect(await (await event.response)!.text()).toBe('<html>offline help</html>');
    await event.done();
  });

  it.each<{ path: string; headers: HeadersInit }>([
    { path: '/help?_rsc=flight', headers: {} },
    { path: '/help', headers: { RSC: '1' } },
    { path: '/help', headers: { 'Next-Router-Prefetch': '1' } },
    { path: '/help', headers: { 'Next-Router-Segment-Prefetch': '/_tree' } },
    { path: '/help', headers: { 'Next-Router-State-Tree': '[]' } },
    { path: '/help', headers: { Purpose: 'prefetch' } },
    { path: '/help', headers: { 'Sec-Purpose': 'prefetch;prerender' } },
    { path: '/help', headers: { Accept: 'text/x-component' } },
  ])('bypasses HTML caches for Next data/prefetch request %j', async ({ path, headers }) => {
    const sw = worker();
    await sw.cache.put('/help', html());
    sw.cache.put.mockClear();
    const event = sw.dispatch('fetch', request(path, { headers }));
    expect(event.event.respondWith).not.toHaveBeenCalled();
    expect(sw.caches.match).not.toHaveBeenCalled();
    expect(sw.caches.open).not.toHaveBeenCalled();
    expect(sw.cache.put).not.toHaveBeenCalled();
    expect(sw.fetch).not.toHaveBeenCalled();
  });

  it.each([
    { navigate: true, contentType: 'text/x-component' },
    { navigate: false, contentType: 'text/x-component; charset=utf-8' },
    { navigate: true, contentType: 'application/json' },
    { navigate: false, contentType: 'application/json' },
  ])('does not store a non-HTML page response %j', async ({ navigate, contentType }) => {
    const sw = worker();
    sw.fetch.mockResolvedValue(
      new Response('not HTML', { headers: { 'Content-Type': contentType } }),
    );
    const event = sw.dispatch('fetch', request('/help', undefined, navigate));
    expect(await (await event.response)!.text()).toBe('not HTML');
    await event.done();
    expect(sw.cache.put).not.toHaveBeenCalled();
  });

  it.each(routes)('does not cache unsuccessful network responses for $path', async (route) => {
    const sw = worker();
    sw.fetch.mockResolvedValue(new Response('unavailable', { status: 503 }));
    const event = sw.dispatch('fetch', request(route.path, undefined, route.navigate));
    expect((await event.response)?.status).toBe(503);
    await event.done();
    expect(sw.cache.put).not.toHaveBeenCalled();
  });

  it.each([
    '/v1/child/home',
    '/v1/child/memories',
    '/v1/child/sessions/session/messages',
    '/v1/me',
    '/api/private',
    'https://api.test/v1/child/home',
  ])('does not intercept private API %s, including direct navigation', (path) => {
    const sw = worker();
    for (const navigate of [false, true]) {
      const event = sw.dispatch('fetch', request(path, undefined, navigate));
      expect(event.event.respondWith).not.toHaveBeenCalled();
    }
    expect(sw.caches.open).not.toHaveBeenCalled();
    expect(sw.cache.put).not.toHaveBeenCalled();
    expect(sw.fetch).not.toHaveBeenCalled();
  });

  it('does not intercept writes or cross-origin assets', () => {
    const sw = worker();
    for (const input of [
      request('/v1/child/help-resources', { method: 'POST' }),
      request('https://other.test/_next/static/chunk.js'),
    ]) {
      expect(sw.dispatch('fetch', input).event.respondWith).not.toHaveBeenCalled();
    }
  });

  it('precaches the safety pages and removes old caches during activation', async () => {
    const sw = worker();
    await sw.dispatch('install').done();
    expect(sw.caches.open).toHaveBeenCalledWith('shell-v3');
    expect(sw.cache.addAll).toHaveBeenCalledWith(
      expect.arrayContaining(['/help', '/safe', '/offline']),
    );
    expect(sw.self.skipWaiting).toHaveBeenCalledOnce();

    await sw.dispatch('activate').done();
    expect(sw.caches.delete.mock.calls).toEqual([
      ['shell-v1'],
      ['api-v1'],
      ['shell-v2'],
      ['api-v2'],
    ]);
    expect(sw.self.clients.claim).toHaveBeenCalledOnce();
  });

  it.each(['/help', '/safe', 'https://api.test/v1/child/help-resources'])(
    'returns cached %s after going offline',
    async (path) => {
      const sw = worker();
      const navigate = !path.startsWith('https:');
      const online = sw.dispatch('fetch', request(path, undefined, navigate));
      await (await online.response)!.text();
      await online.done();
      sw.fetch.mockRejectedValue(new TypeError('offline'));

      const offline = sw.dispatch('fetch', request(`${path}?retry=1`, undefined, navigate));
      expect(await (await offline.response)!.text()).toBe('<html>offline help</html>');
      await offline.done();
    },
  );

  it('falls back to the offline page for an uncached navigation', async () => {
    const sw = worker();
    await sw.cache.put('/offline', html('offline fallback'));
    sw.fetch.mockRejectedValue(new TypeError('offline'));
    const event = sw.dispatch('fetch', request('/uncached', undefined, true));
    expect(await (await event.response)!.text()).toBe('offline fallback');
  });
});
