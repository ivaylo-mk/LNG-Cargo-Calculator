/*
 * Service Worker for LNG Cargo Properties Calculator PWA — v2.5.2
 *
 * Strategy:
 *   - Navigations (the app itself): NETWORK-FIRST with cache fallback.
 *     Online users always run the latest deployed version and the cache is
 *     refreshed on every successful load. Offline users get the cached copy.
 *     A navigation that misses the cache exactly falls back to ./index.html,
 *     so the app opens offline regardless of query strings or entry URL.
 *   - Static assets (icons, manifest, standalone file): CACHE-FIRST with
 *     runtime caching. These rarely change.
 *
 * Install resilience:
 *   Only './' and './index.html' are REQUIRED for install to succeed.
 *   All other assets are cached best-effort, individually. A single missing
 *   or renamed icon can therefore no longer abort the entire install and
 *   silently disable offline capability (cache.addAll is atomic — one 404
 *   kills everything — which is the classic cause of a PWA that "has a
 *   service worker" yet still shows Chrome's grey "You're Offline" page).
 *
 * Versioning:
 *   Bump CACHE_NAME on each release so stale caches are purged on activate.
 *   Because navigations are network-first, users no longer run a stale
 *   index.html while online even if the bump is forgotten.
 */
const CACHE_NAME = 'lng-cargo-v2.5.2';

/* Install fails (and retries next visit) if these cannot be cached. */
const CRITICAL_ASSETS = [
  './',
  './index.html'
];

/* Cached best-effort; a failure here is logged but never blocks install. */
const OPTIONAL_ASSETS = [
  './LNG_Cargo_Properties_Calculator.html',
  './manifest.json',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) =>
        cache.addAll(CRITICAL_ASSETS).then(() =>
          Promise.all(OPTIONAL_ASSETS.map((url) =>
            cache.add(url).catch((err) => {
              console.warn('[SW] Optional asset not cached:', url, err);
            })
          ))
        )
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      ))
      .then(() => backfillMissingAssets())
      .then(() => self.clients.claim())
  );
});

/*
 * Self-healing: re-attempt any asset (critical or optional) that is not
 * currently in the cache. Runs on activation and after every successful
 * online app launch, so an asset that failed once — flaky connection,
 * temporary 404 — is retried on each online use until the cache is
 * complete. Assets already cached are skipped (cache.match only; no
 * network traffic for a complete cache).
 */
function backfillMissingAssets() {
  const ALL_ASSETS = CRITICAL_ASSETS.concat(OPTIONAL_ASSETS);
  return caches.open(CACHE_NAME).then((cache) =>
    Promise.all(ALL_ASSETS.map((url) =>
      cache.match(url, { ignoreSearch: true }).then((hit) => {
        if (hit) return;
        return cache.add(url).catch((err) => {
          console.warn('[SW] Backfill failed, will retry next online launch:', url, err);
        });
      })
    ))
  );
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  /* Same-origin only; let the browser handle anything external. */
  if (new URL(request.url).origin !== self.location.origin) return;

  /* ── Navigations: network-first, cache fallback, index.html safety net ── */
  if (request.mode === 'navigate' || request.destination === 'document') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
            /* We are demonstrably online: repair any gaps in the cache. */
            event.waitUntil(backfillMissingAssets());
          }
          return response;
        })
        .catch(() =>
          caches.match(request, { ignoreSearch: true })
            .then((cached) => cached || caches.match('./index.html'))
            .then((cached) => cached || offlineFallbackPage())
        )
    );
    return;
  }

  /* ── Static assets: cache-first with runtime caching ── */
  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((response) => {
          if (response && response.status === 200 && response.type === 'basic') {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() =>
          /* Offline and not cached: return a proper Response rather than
             undefined, which would throw a TypeError in respondWith. */
          new Response('', { status: 504, statusText: 'Offline — resource not cached' })
        );
    })
  );
});

function offlineFallbackPage() {
  return new Response(
    '<!DOCTYPE html><meta charset="utf-8"><title>Offline</title>' +
    '<body style="font-family:system-ui;padding:2rem;color:#eef;background:#070d1a;">' +
    '<h1>Offline</h1><p>The app has not been cached on this device yet. ' +
    'Connect to the internet and open the app once to install it for offline use.</p></body>',
    { headers: { 'Content-Type': 'text/html' } }
  );
}
