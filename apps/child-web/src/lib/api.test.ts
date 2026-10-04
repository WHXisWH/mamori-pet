import { afterEach, expect, it, vi } from 'vitest';
import { ChildApiError, childRequest, devHeaders } from './api';

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
