// Axia's service worker: the app opens instantly and works offline with the
// results it last loaded. Online, the page itself is always fetched fresh
// (network first), so a redirect to the Cloudflare Access login passes straight
// through and new results show at once. Icons and fonts are served from cache.
// The page is cached only on your device, and only after you have signed in.

const VERSION = '__AXIA_VERSION__';
const CACHE = `axia-${VERSION}`;
const ASSETS = __AXIA_ASSETS__;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(ASSETS);
      // Keep the results you are looking at now, so the app opens offline right after you install it.
      try {
        const page = await fetch('./', { cache: 'no-store', redirect: 'manual' });
        if (page.ok && page.type === 'basic') await cache.put('./', page);
      } catch {
        // Not signed in, or offline: the page is cached on the next visit instead.
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key.startsWith('axia-') && key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.endsWith('/version.json') || url.pathname.includes('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          if (response.ok && response.type === 'basic') (await caches.open(CACHE)).put('./', response.clone());
          return response;
        } catch {
          return (await caches.match('./')) ?? Response.error();
        }
      })(),
    );
    return;
  }

  event.respondWith(caches.match(request).then((hit) => hit ?? fetch(request)));
});
