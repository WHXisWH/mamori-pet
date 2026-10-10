import { afterEach, expect, it, vi } from 'vitest';
import { ChildApiError, childFetch, childRequest, devHeaders } from './api';

vi.mock('./app-check', () => ({
  childAppCheckToken: vi.fn(async (forceRefresh = false) =>
    forceRefresh ? 'fresh-app-check' : 'initial-app-check',
  ),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  localStorage.clear();
});

it('only sends the local identity in explicitly enabled development mode', () => {
  localStorage.setItem('mamori-child', JSON.stringify({ state: { childId: 'c_dev' } }));
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('NEXT_PUBLIC_LOCAL_DEMO', '0');
  expect(devHeaders()).toEqual({});
  vi.stubEnv('NEXT_PUBLIC_LOCAL_DEMO', '1');
  expect(devHeaders()).toEqual({ 'X-Dev-Child-Id': 'c_dev' });
});

it('does not replace multipart boundaries or turn a rejected submission into success', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(
    async () =>
      new Response(JSON.stringify({ error: { code: 'DATA_SOURCE_DISABLED' } }), { status: 403 }),
  );
  vi.stubGlobal('fetch', fetch);
  const form = new FormData();
  form.set('image', new Blob(['synthetic']), 'drawing.png');
  await expect(childRequest('/v1/child/artworks', { method: 'POST', body: form })).rejects.toEqual(
    new ChildApiError('DATA_SOURCE_DISABLED', 403),
  );
  const init = fetch.mock.calls[0]?.[1] as RequestInit;
  expect(new Headers(init.headers).has('Content-Type')).toBe(false);
  expect(init.body).toBe(form);
});

it('accepts an empty DELETE response without parsing nonexistent JSON', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 204 })),
  );
  await expect(
    childRequest('/v1/child/memories/m_1', { method: 'DELETE' }),
  ).resolves.toBeUndefined();
});

it('refreshes App Check when auth is not present but the App Check token expired', async () => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('NEXT_PUBLIC_FIREBASE_APP_CHECK_SITE_KEY', 'test-site-key');
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 401 }))
    .mockResolvedValueOnce(new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  const response = await childFetch('/v1/child/home', {
    headers: { 'X-Firebase-AppCheck': 'expired-app-check' },
  });
  expect(response.status).toBe(200);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get('X-Firebase-AppCheck')).toBe(
    'fresh-app-check',
  );
});
