const VERSION = 'v1';
const SHELL_CACHE = `shell-${VERSION}`;
const PRECACHE = ['/offline', '/manifest.webmanifest', '/icons/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || request.mode !== 'navigate') return;
  event.respondWith(
    fetch(request).catch(async () => (await caches.match('/offline')) || Response.error()),
  );
});

function sameOriginPath(value) {
  try {
    const url = new URL(value, self.location.origin);
    return url.origin === self.location.origin ? url.pathname + url.search : null;
  } catch {
    return null;
  }
}

function pushPayload(event) {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }
  const n = payload.notification || {};
  const id = payload.data && payload.data.notificationId;
  const link = payload.fcmOptions && payload.fcmOptions.link;
  return {
    title: typeof n.title === 'string' && n.title ? n.title : 'まもりペット',
    body:
      typeof n.body === 'string' && n.body
        ? n.body
        : '新しいお知らせがあります。アプリで確認してください。',
    url:
      (typeof link === 'string' && sameOriginPath(link)) ||
      (typeof id === 'string' ? `/notifications/${encodeURIComponent(id)}` : '/'),
  };
}

self.addEventListener('push', (event) => {
  const { title, body, url } = pushPayload(event);
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: '/icons/icon.svg',
      data: { url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = sameOriginPath(event.notification.data?.url || '/') || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const open = list.find((c) => new URL(c.url).origin === self.location.origin);
      if (open) return open.navigate(url).then((c) => (c || open).focus());
      return self.clients.openWindow(url);
    }),
  );
});
