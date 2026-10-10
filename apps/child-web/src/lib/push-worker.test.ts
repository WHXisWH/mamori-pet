// @vitest-environment node
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8');
const copy = JSON.parse(
  readFileSync(new URL('../../public/push-copy.json', import.meta.url), 'utf8'),
);
const deviceId = 'a'.repeat(64);

function worker(time = '2026-10-06T07:00:00Z') {
  const events = new Map<string, (event: unknown) => void>();
  const showNotification = vi.fn(async () => {});
  const matchAll = vi.fn(
    async () =>
      [] as { url: string; navigate: ReturnType<typeof vi.fn>; focus: ReturnType<typeof vi.fn> }[],
  );
  const openWindow = vi.fn(async () => {});
  let bound = true;
  const caches = {
    open: async () => ({
      match: async () => (bound ? new Response(JSON.stringify({ deviceId })) : undefined),
    }),
    match: async () => new Response(JSON.stringify(copy)),
  };
  class Clock extends Date {
    constructor() {
      super(time);
    }
  }
  runInNewContext(source, {
    self: {
      addEventListener: (name: string, fn: (event: unknown) => void) => events.set(name, fn),
      location: new URL('https://child.test'),
      registration: { showNotification },
      clients: { matchAll, openWindow },
    },
    caches,
    URL,
    Date: Clock,
  });
  async function dispatch(name: string, fields: Record<string, unknown>) {
    let work: Promise<unknown> | undefined;
    events.get(name)!({
      ...fields,
      waitUntil: (value: Promise<unknown>) => {
        work = value;
      },
    });
    await work;
  }
  return {
    showNotification,
    matchAll,
    openWindow,
    dispatch,
    unbind: () => {
      bound = false;
    },
  };
}

describe('child push worker', () => {
  it('displays only bundled KB copy, ignoring remote text, identity and link', async () => {
    const sw = worker();
    await sw.dispatch('push', {
      data: {
        json: () => ({
          data: {
            kind: 'child_greeting',
            deviceId,
            title: 'private',
            body: 'secret child content',
            url: 'https://evil.test',
          },
        }),
      },
    });
    expect(sw.showNotification).toHaveBeenCalledWith(copy.title, {
      body: copy.body,
      icon: '/icons/icon.svg',
      tag: 'child-greeting',
      data: { path: '/' },
    });
    expect(JSON.stringify(sw.showNotification.mock.calls)).not.toMatch(/secret|private|evil/);
  });
  it.each(['2026-10-06T14:00:00Z', '2026-10-05T19:59:00Z'])(
    'suppresses background push in JST quiet hours %s',
    async (at) => {
      const sw = worker(at);
      await sw.dispatch('push', {
        data: { json: () => ({ data: { kind: 'child_greeting', deviceId } }) },
      });
      expect(sw.showNotification).not.toHaveBeenCalled();
    },
  );
  it('suppresses revoked bindings and messages for an old device', async () => {
    const sw = worker();
    await sw.dispatch('push', {
      data: { json: () => ({ data: { kind: 'child_greeting', deviceId: 'old' } }) },
    });
    sw.unbind();
    await sw.dispatch('push', {
      data: { json: () => ({ data: { kind: 'child_greeting', deviceId } }) },
    });
    expect(sw.showNotification).not.toHaveBeenCalled();
  });
  it('ignores malformed and unrelated push payloads', async () => {
    const sw = worker();
    await sw.dispatch('push', {
      data: {
        json: () => {
          throw new Error('invalid');
        },
      },
    });
    await sw.dispatch('push', {
      data: { json: () => ({ notification: { title: 'not allowed' } }) },
    });
    expect(sw.showNotification).not.toHaveBeenCalled();
  });
  it('opens only the same-origin home page regardless of notification data', async () => {
    const sw = worker();
    const close = vi.fn();
    await sw.dispatch('notificationclick', {
      notification: { close, data: { path: 'https://evil.test', url: 'javascript:alert(1)' } },
    });
    expect(close).toHaveBeenCalledOnce();
    expect(sw.openWindow).toHaveBeenCalledWith('https://child.test/');
  });
  it('navigates and focuses an existing same-origin client, never an unrelated client', async () => {
    const sw = worker();
    const client = {
      url: 'https://child.test/settings',
      navigate: vi.fn(async () => {}),
      focus: vi.fn(async () => {}),
    };
    const other = { url: 'https://evil.test', navigate: vi.fn(), focus: vi.fn() };
    sw.matchAll.mockResolvedValue([other, client]);
    await sw.dispatch('notificationclick', { notification: { close: vi.fn() } });
    expect(client.navigate).toHaveBeenCalledWith('https://child.test/');
    expect(client.focus).toHaveBeenCalledOnce();
    expect(other.focus).not.toHaveBeenCalled();
    expect(sw.openWindow).not.toHaveBeenCalled();
  });
});
