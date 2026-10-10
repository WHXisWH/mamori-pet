import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type Worker } from '@playwright/test';

const sw = readFileSync(new URL('../public/sw.js', import.meta.url));
const copy = readFileSync(new URL('../public/push-copy.json', import.meta.url));
const icon = readFileSync(new URL('../public/icons/icon.svg', import.meta.url));
const deviceId = 'a'.repeat(64);
let server: Server;
let origin: string;

// A separate origin keeps synthetic push state out of the developer's running preview.
test.beforeAll(async () => {
  server = createServer((req, res) => {
    const path = req.url?.split('?')[0];
    if (path === '/sw.js') {
      res.writeHead(200, {
        'Content-Type': 'application/javascript',
        'Service-Worker-Allowed': '/',
      });
      res.end(sw);
    } else if (path === '/push-copy.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(copy);
    } else if (path === '/icons/icon.svg') {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      res.end(icon);
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(
        '<!doctype html><html lang="ja"><title>Push integration fixture</title><body>Local push fixture</body></html>',
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

type WorkerScope = {
  registration: ServiceWorkerRegistration;
  __notifications: { title: string; options?: NotificationOptions }[];
  __focusCalls: number;
  clients: {
    matchAll: () => Promise<
      { url: string; navigate: (url: string) => Promise<unknown>; focus: () => Promise<unknown> }[]
    >;
  };
  Date: DateConstructor;
};

async function push(worker: Worker, tokenId = deviceId) {
  await worker.evaluate(async (id) => {
    const work: Promise<unknown>[] = [];
    const event = new Event('push');
    Object.defineProperties(event, {
      data: {
        value: {
          json: () => ({
            data: {
              kind: 'child_greeting',
              deviceId: id,
              title: 'PRIVATE TITLE',
              body: 'PRIVATE MESSAGE',
              url: 'https://outside.test',
            },
          }),
        },
      },
      waitUntil: { value: (value: Promise<unknown>) => work.push(value) },
    });
    dispatchEvent(event);
    await Promise.all(work);
  }, tokenId);
}

test('real worker uses fixed copy, rejects revoked/old tokens and keeps clicks on the home origin', async ({
  page,
  context,
}) => {
  await page.goto(origin + '/safe');
  await page.evaluate(async (id) => {
    await (
      await caches.open('child-push-v1')
    ).put(
      '/__child-push-binding',
      new Response(JSON.stringify({ childId: 'synthetic', deviceId: id })),
    );
    await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    await navigator.serviceWorker.ready;
  }, deviceId);
  const worker = context
    .serviceWorkers()
    .find((candidate) => candidate.url() === origin + '/sw.js');
  expect(worker).toBeTruthy();
  await worker!.evaluate(() => {
    const scope = globalThis as unknown as WorkerScope;
    scope.__notifications = [];
    scope.registration.showNotification = async (title, options) => {
      scope.__notifications.push({ title, ...(options ? { options } : {}) });
    };
    const OriginalDate = Date;
    scope.Date = class extends OriginalDate {
      constructor() {
        super('2026-10-06T07:00:00Z');
      }
    } as DateConstructor;
  });
  await push(worker!);
  const notices = await worker!.evaluate(
    () => (globalThis as unknown as WorkerScope).__notifications,
  );
  const fixed = JSON.parse(copy.toString()) as { title: string; body: string };
  expect(notices).toEqual([
    {
      title: fixed.title,
      options: {
        body: fixed.body,
        icon: '/icons/icon.svg',
        tag: 'child-greeting',
        data: { path: '/' },
      },
    },
  ]);
  expect(JSON.stringify(notices)).not.toMatch(/PRIVATE|outside/);

  await push(worker!, 'old-device');
  await page.evaluate(async () => {
    await (await caches.open('child-push-v1')).delete('/__child-push-binding');
  });
  await push(worker!);
  expect(
    await worker!.evaluate(() => (globalThis as unknown as WorkerScope).__notifications.length),
  ).toBe(1);

  await worker!.evaluate(async () => {
    const scope = globalThis as unknown as WorkerScope;
    scope.__focusCalls = 0;
    const matchAll = scope.clients.matchAll.bind(scope.clients);
    // A synthetic event has no OS user activation. Keep actual navigation, spy only on focus.
    scope.clients.matchAll = async () =>
      (await matchAll()).map((client) => ({
        url: client.url,
        navigate: client.navigate.bind(client),
        focus: async () => {
          scope.__focusCalls++;
          return client;
        },
      }));
    const work: Promise<unknown>[] = [];
    const event = new Event('notificationclick');
    Object.defineProperties(event, {
      notification: {
        value: { close() {}, data: { url: 'https://outside.test', path: '//outside.test' } },
      },
      waitUntil: { value: (value: Promise<unknown>) => work.push(value) },
    });
    dispatchEvent(event);
    await Promise.all(work);
  });
  await expect(page).toHaveURL(origin + '/');
  expect(await worker!.evaluate(() => (globalThis as unknown as WorkerScope).__focusCalls)).toBe(1);
});
