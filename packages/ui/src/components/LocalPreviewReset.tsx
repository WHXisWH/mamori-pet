'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

type ResetTarget = '/pair' | '/signup';
type ResetBrowser = {
  location: Pick<Location, 'href' | 'replace'>;
  localStorage: Storage;
  sessionStorage: Storage;
  caches?: Pick<CacheStorage, 'keys' | 'delete'>;
  navigator: { serviceWorker?: Pick<ServiceWorkerContainer, 'getRegistrations'> };
};

function removeAppKeys(storage: Storage) {
  for (let i = storage.length - 1; i >= 0; i--) {
    const key = storage.key(i);
    if (key?.startsWith('mamori-')) storage.removeItem(key);
  }
}

export async function resetLocalPreview(
  enabled: boolean,
  target: ResetTarget,
  browser: ResetBrowser = window,
): Promise<boolean> {
  if (!enabled) return false;
  const url = new URL(browser.location.href);
  const loopback =
    url.hostname === 'localhost' ||
    url.hostname === '[::1]' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(url.hostname);
  if (!loopback || url.searchParams.get('resetLocal') !== '1') return false;

  removeAppKeys(browser.localStorage);
  removeAppKeys(browser.sessionStorage);

  if (browser.navigator.serviceWorker) {
    const registrations = await browser.navigator.serviceWorker.getRegistrations();
    for (const registration of registrations) {
      const workers = [registration.active, registration.waiting, registration.installing].filter(
        (worker): worker is ServiceWorker => worker !== null,
      );
      if (
        new URL(registration.scope).origin === url.origin &&
        workers.length > 0 &&
        workers.every((worker) => {
          const script = new URL(worker.scriptURL);
          return script.origin === url.origin && script.pathname === '/sw.js';
        })
      ) {
        await registration.unregister();
      }
    }
  }

  // Both apps currently use shell-; retain support for guardian-specific shell caches.
  if (browser.caches) {
    for (const key of await browser.caches.keys()) {
      if (['shell-', 'api-', 'guardian-shell-'].some((prefix) => key.startsWith(prefix))) {
        await browser.caches.delete(key);
      }
    }
  }

  browser.location.replace(target);
  return true;
}

export function LocalPreviewReset({
  enabled,
  target,
  children,
}: {
  enabled: boolean;
  target: ResetTarget;
  children: ReactNode;
}) {
  const [status, setStatus] = useState<'checking' | 'ready' | 'failed'>('checking');
  const operation = useRef<Promise<boolean> | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let mounted = true;
    // Share the operation across StrictMode effect replay, including its redirect.
    operation.current ??= resetLocalPreview(enabled, target);
    void operation.current.then(
      (reset) => {
        if (mounted && !reset) setStatus('ready');
      },
      () => {
        if (mounted) setStatus('failed');
      },
    );
    return () => {
      mounted = false;
    };
  }, [enabled, target]);

  // Keep guards, stores' subscribers and service-worker registration unmounted until checked.
  if (!enabled || status === 'ready') return <>{children}</>;

  return (
    <main className="mx-auto max-w-lg px-4 py-12" aria-busy={status === 'checking'}>
      {status === 'failed' ? (
        <div role="alert">
          <h1 className="text-xl font-bold">ローカル体験のリセットが完了しませんでした</h1>
          <p className="mt-3">
            一部のデータが残っている可能性があります。ブラウザーの保存設定を確認して、もう一度お試しください。
          </p>
          <button
            type="button"
            className="mt-4 min-h-11 rounded-md border px-4 py-2"
            onClick={() => window.location.reload()}
          >
            再読み込みして再試行
          </button>
        </div>
      ) : (
        <p role="status">ローカル体験を確認しています…</p>
      )}
    </main>
  );
}
