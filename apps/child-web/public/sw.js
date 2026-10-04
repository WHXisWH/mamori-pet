const VERSION = 'v2';
const SHELL_CACHE = `shell-${VERSION}`;
const API_CACHE = `api-${VERSION}`;
const SHELL_PAGES = ['/help', '/safe', '/offline', '/'];
const PRECACHE = [...SHELL_PAGES, '/manifest.webmanifest', '/icons/icon.svg'];

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
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== SHELL_CACHE && k !== API_CACHE).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

function isHelpResourcesApi(url) {
  return url.pathname === '/v1/child/help-resources';
}

function cacheResponse(event, cacheName, response) {
  const contentType = (response.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  const isPage =
    cacheName === SHELL_CACHE &&
    (event.request.mode === 'navigate' || SHELL_PAGES.includes(new URL(event.request.url).pathname));
  if (!response.ok || contentType === 'text/x-component' || (isPage && contentType !== 'text/html')) {
    return;
  }

  // Clone before returning the response; cache opening may outlive body consumption.
  const copy = response.clone();
  event.waitUntil(
    caches
      .open(cacheName)
      .then((cache) => cache.put(event.request, copy))
      .catch(() => {}),
  );
}

async function networkFirst(event, cacheName, fallbackPath) {
  const { request } = event;
  try {
    const response = await fetch(request);
    cacheResponse(event, cacheName, response);
    return response;
  } catch (err) {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    if (fallbackPath) {
      const fallback = await caches.match(fallbackPath);
      if (fallback) return fallback;
    }
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // Next data and prefetch requests must never share the document cache.
  if (
    url.searchParams.has('_rsc') ||
    request.headers.has('RSC') ||
    request.headers.has('Next-Router-State-Tree') ||
    request.headers.has('Next-Router-Prefetch') ||
    request.headers.has('Next-Router-Segment-Prefetch') ||
    (request.headers.get('Accept') || '').includes('text/x-component') ||
    (request.headers.get('Purpose') || '').includes('prefetch') ||
    (request.headers.get('Sec-Purpose') || '').includes('prefetch')
  ) {
    return;
  }

  if (isHelpResourcesApi(url)) {
    event.respondWith(networkFirst(event, API_CACHE));
    return;
  }

  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/v1/') || url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(event, SHELL_CACHE, '/offline'));
    return;
  }

  if (url.pathname.startsWith('/_next/static/') || PRECACHE.includes(url.pathname)) {
    event.respondWith(
      caches
        .match(request)
        .catch(() => undefined)
        .then(
          (cached) =>
            cached ||
            fetch(request).then((response) => {
              cacheResponse(event, SHELL_CACHE, response);
              return response;
            }),
        ),
    );
  }
});
