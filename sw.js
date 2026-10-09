// MDPD Live Traffic Feed — app-shell service worker.
//
// Strategy
//   • Navigations (the page itself): network-first, falling back to the last
//     cached copy when offline. A deploy is picked up on the next online load.
//   • Fonts, Leaflet, MarkerCluster (immutable, versioned CDN URLs): cache-first.
//   • /api/traffic and everything else: not intercepted. The page already has
//     its own honest fallback chain and must decide for itself what is LIVE.
//
// Bump CACHE_VERSION whenever the shell list changes.
const CACHE_VERSION = 'mdpd-shell-v1';

const SHELL = [
  '/',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

const CDN_HOSTS = new Set([
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'cdnjs.cloudflare.com'
]);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(c => c.addAll(SHELL))
      .catch(() => { /* a missing icon must not block install */ })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Never cache the live feed or any other API route.
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) return;

  if (req.mode === 'navigate') {
    event.respondWith(networkFirst(req));
    return;
  }

  if (CDN_HOSTS.has(url.hostname)) {
    event.respondWith(cacheFirst(req));
  }
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE_VERSION);
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok) cache.put('/', fresh.clone());
    return fresh;
  } catch {
    const cached = await cache.match('/');
    if (cached) return cached;
    throw new Error('offline and no cached shell');
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(req);
  if (cached) return cached;
  const fresh = await fetch(req);
  // Opaque (no-cors) responses from the CDN are fine to keep.
  if (fresh && (fresh.ok || fresh.type === 'opaque')) cache.put(req, fresh.clone());
  return fresh;
}
