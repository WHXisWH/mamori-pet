import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { StrictMode, useEffect } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LocalPreviewReset, resetLocalPreview } from './LocalPreviewReset.js';

function storage() {
  const values = new Map([
    ['mamori-child', 'old-child'],
    ['mamori-guardian-id', 'old-guardian'],
    ['mamori-draft', 'old-draft'],
    ['foreign-key', 'keep'],
    ['other-mamori-key', 'keep'],
    ['mamori', 'keep'],
    ['firebase:authUser:google', 'keep'],
  ]);
  return {
    get length() {
      return values.size;
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: vi.fn((key: string) => void values.delete(key)),
    clear: vi.fn(),
  };
}

function registration(scriptURL: string, scope = 'http://localhost:4500/') {
  return {
    scope,
    active: { scriptURL },
    waiting: null,
    installing: null,
    unregister: vi.fn(async () => true),
  } as unknown as ServiceWorkerRegistration;
}

function browser(href = 'http://localhost:4500/?resetLocal=1') {
  return {
    location: { href, replace: vi.fn() },
    localStorage: storage(),
    sessionStorage: storage(),
    caches: {
      keys: vi.fn(async () => [
        'shell-v2',
        'shell-v1',
        'api-v2',
        'guardian-shell-v1',
        'foreign-cache',
        'other-shell-v1',
        'shell',
      ]),
      delete: vi.fn(async (_name: string) => true),
    },
    navigator: {
      serviceWorker: {
        getRegistrations: vi.fn(async (): Promise<ServiceWorkerRegistration[]> => []),
      },
    },
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('resetLocalPreview', () => {
  it('only deletes app-prefixed storage and caches, preserving other apps and credentials', async () => {
    const env = browser();
    expect(await resetLocalPreview(true, '/pair', env)).toBe(true);
    for (const store of [env.localStorage, env.sessionStorage]) {
      expect(store.removeItem.mock.calls.map(([key]) => key).sort()).toEqual([
        'mamori-child',
        'mamori-draft',
        'mamori-guardian-id',
      ]);
      for (const key of ['foreign-key', 'other-mamori-key', 'mamori', 'firebase:authUser:google']) {
        expect(store.getItem(key)).toBe('keep');
      }
      expect(store.clear).not.toHaveBeenCalled();
    }
    expect(env.caches.delete.mock.calls.map(([key]) => key)).toEqual([
      'shell-v2',
      'shell-v1',
      'api-v2',
      'guardian-shell-v1',
    ]);
    expect(env.location.replace).toHaveBeenCalledExactlyOnceWith('/pair');
  });

  it.each([
    [false, 'http://localhost:4500/?resetLocal=1'],
    [true, 'https://mamori.example/?resetLocal=1'],
    [true, 'http://localhost.example/?resetLocal=1'],
    [true, 'http://192.168.1.1/?resetLocal=1'],
    [true, 'http://localhost:4500/'],
    [true, 'http://localhost:4500/help'],
    [true, 'http://localhost:4500/offline'],
    [true, 'http://localhost:4500/?resetLocal=0'],
    [true, 'http://localhost:4500/?resetLocal=true'],
    [true, 'http://localhost:4500/#resetLocal=1'],
  ])('does nothing with enabled=%s at %s', async (enabled, href) => {
    const env = browser(href);
    expect(await resetLocalPreview(enabled, '/pair', env)).toBe(false);
    expect(env.localStorage.removeItem).not.toHaveBeenCalled();
    expect(env.sessionStorage.removeItem).not.toHaveBeenCalled();
    expect(env.caches.keys).not.toHaveBeenCalled();
    expect(env.navigator.serviceWorker.getRegistrations).not.toHaveBeenCalled();
    expect(env.location.replace).not.toHaveBeenCalled();
  });

  it.each(['localhost', '127.0.0.1', '127.0.0.2', '[::1]'])('accepts loopback %s', async (host) => {
    const env = browser(`http://${host}:4501/?resetLocal=1&target=https://example.com`);
    await resetLocalPreview(true, '/signup', env);
    expect(env.location.replace).toHaveBeenCalledExactlyOnceWith('/signup');
  });

  it('only unregisters same-origin /sw.js, including waiting and installing workers', async () => {
    const env = browser();
    const active = registration('http://localhost:4500/sw.js');
    const waiting = registration('http://localhost:4500/sw.js?v=2');
    Object.assign(waiting, { active: null, waiting: waiting.active });
    const installing = registration('http://localhost:4500/sw.js');
    Object.assign(installing, { active: null, installing: installing.active });
    const foreign = [
      registration('http://localhost:4500/other/sw.js'),
      registration('http://localhost:4501/sw.js', 'http://localhost:4501/'),
      registration('https://example.com/sw.js'),
      registration('http://localhost:4500/sw.js', 'http://localhost:4501/'),
      registration('http://localhost:4500/worker.js'),
    ];
    env.navigator.serviceWorker.getRegistrations.mockResolvedValue([
      active,
      waiting,
      installing,
      ...foreign,
    ]);
    await resetLocalPreview(true, '/pair', env);
    for (const worker of [active, waiting, installing])
      expect(worker.unregister).toHaveBeenCalledOnce();
    for (const worker of foreign) expect(worker.unregister).not.toHaveBeenCalled();
  });

  it('waits for cleanup before redirect and supports repeated reset with absent entries', async () => {
    const env = browser();
    let finish!: (deleted: boolean) => void;
    env.caches.delete.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const reset = resetLocalPreview(true, '/pair', env);
    await waitFor(() => expect(env.caches.delete).toHaveBeenCalled());
    expect(env.location.replace).not.toHaveBeenCalled();
    finish(true);
    await reset;
    env.caches.delete.mockResolvedValue(false);
    const worker = registration('http://localhost:4500/sw.js');
    vi.mocked(worker.unregister).mockResolvedValue(false);
    env.navigator.serviceWorker.getRegistrations.mockResolvedValue([worker]);
    await resetLocalPreview(true, '/pair', env);
    expect(env.location.replace).toHaveBeenCalledTimes(2);
    expect(env.localStorage.getItem('foreign-key')).toBe('keep');
  });

  it('works when optional service-worker and cache APIs are unavailable', async () => {
    const env = browser();
    await resetLocalPreview(true, '/pair', {
      location: env.location,
      localStorage: env.localStorage,
      sessionStorage: env.sessionStorage,
      navigator: {},
    });
    expect(env.location.replace).toHaveBeenCalledExactlyOnceWith('/pair');
  });

  it.each([
    'localStorage',
    'sessionStorage',
    'registrations',
    'unregister',
    'cacheList',
    'cacheDelete',
  ])('rejects %s failure without redirecting', async (stage) => {
    const env = browser();
    const failure = new Error('blocked');
    if (stage === 'localStorage' || stage === 'sessionStorage') {
      env[stage].removeItem.mockImplementation(() => {
        throw failure;
      });
    } else if (stage === 'registrations') {
      env.navigator.serviceWorker.getRegistrations.mockRejectedValue(failure);
    } else if (stage === 'unregister') {
      const worker = registration('http://localhost:4500/sw.js');
      vi.mocked(worker.unregister).mockRejectedValue(failure);
      env.navigator.serviceWorker.getRegistrations.mockResolvedValue([worker]);
    } else if (stage === 'cacheList') env.caches.keys.mockRejectedValue(failure);
    else env.caches.delete.mockRejectedValue(failure);
    await expect(resetLocalPreview(true, '/pair', env)).rejects.toThrow('blocked');
    expect(env.location.replace).not.toHaveBeenCalled();
  });
});

function useBrowser(env: ReturnType<typeof browser>) {
  const overrides = new Map<PropertyKey, unknown>(Object.entries(env));
  vi.stubGlobal(
    'window',
    new Proxy(window, {
      get: (real, key) => (overrides.has(key) ? overrides.get(key) : Reflect.get(real, key)),
    }),
  );
}

describe('LocalPreviewReset', () => {
  it('never mounts children during cleanup or redirect, including StrictMode replay', async () => {
    const env = browser();
    useBrowser(env);
    let finish!: (keys: string[]) => void;
    env.caches.keys.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const mounted = vi.fn();
    function Child() {
      useEffect(mounted, []);
      return <p>Old account</p>;
    }
    render(
      <StrictMode>
        <LocalPreviewReset enabled target="/pair">
          <Child />
        </LocalPreviewReset>
      </StrictMode>,
    );
    await waitFor(() => expect(env.caches.keys).toHaveBeenCalledOnce());
    expect(mounted).not.toHaveBeenCalled();
    expect(screen.queryByText('Old account')).toBeNull();
    await act(async () => {
      finish([]);
    });
    expect(env.location.replace).toHaveBeenCalledExactlyOnceWith('/pair');
    expect(mounted).not.toHaveBeenCalled();
  });

  it('keeps children blocked on failure and offers reload without reporting success', async () => {
    const env = browser();
    useBrowser(env);
    env.caches.keys.mockRejectedValue(new Error('private storage failure'));
    render(
      <LocalPreviewReset enabled target="/signup">
        <p>Old account</p>
      </LocalPreviewReset>,
    );
    expect((await screen.findByRole('alert')).textContent).toContain('完了しませんでした');
    expect(screen.queryByText('Old account')).toBeNull();
    expect(screen.getByRole('button').textContent).toContain('再試行');
    expect(env.location.replace).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'allows normal paths without clearing state (demo=%s)',
    async (enabled) => {
      const env = browser('http://localhost:4500/help');
      useBrowser(env);
      render(
        <LocalPreviewReset enabled={enabled} target="/pair">
          <p>Help resources</p>
        </LocalPreviewReset>,
      );
      expect(await screen.findByText('Help resources')).toBeTruthy();
      expect(env.localStorage.removeItem).not.toHaveBeenCalled();
      expect(env.caches.keys).not.toHaveBeenCalled();
    },
  );

  it('preserves production server rendering and blocks demo children before hydration', () => {
    expect(
      renderToString(
        <LocalPreviewReset enabled={false} target="/pair">
          <p>Help resources</p>
        </LocalPreviewReset>,
      ),
    ).toContain('Help resources');
    expect(
      renderToString(
        <LocalPreviewReset enabled target="/pair">
          <p>Old account</p>
        </LocalPreviewReset>,
      ),
    ).not.toContain('Old account');
  });
});
