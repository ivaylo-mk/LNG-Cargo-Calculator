/*
 * Service Worker for LNG Cargo Properties Calculator PWA — v2.6.0
 *
 * Strategy:
 *   - Navigations (the app itself): STALE-WHILE-REVALIDATE. The cached app
 *     is served instantly — startup speed is independent of connection
 *     quality — while the latest deployed version is fetched in the
 *     background and cached for the next launch. Network-first was tried in
 *     v2.5.2 and reverted: on slow-but-alive connections (ship VSAT,
 *     congested port Wi-Fi) fetch() hangs rather than fails, freezing the
 *     app on the splash screen.
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
 *   Because navigations revalidate in the background on every online launch,
 *   users pick up a new index.html by their second online launch even if
 *   the bump is forgotten.
 */
const CACHE_NAME = 'lng-cargo-v2.6.0';

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

  /* ── Navigations: STALE-WHILE-REVALIDATE ──
     Serve the cached app INSTANTLY (cache reads are milliseconds regardless
     of connection quality), then fetch the latest version in the background
     and update the cache for the next launch. This avoids the network-first
     pitfall on slow-but-alive connections ("lie-fi"), where fetch() does not
     fail — it hangs, holding the app on the splash screen for as long as the
     browser is willing to wait. Tradeoff: after a redeploy, a device runs
     the new version from its second online launch onward. */
  if (request.mode === 'navigate' || request.destination === 'document') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(request, { ignoreSearch: true })
                  || await cache.match('./index.html');

      /* Background revalidation: refresh index.html and repair any cache
         gaps. Never blocks the response below; failures are silent and
         retried on the next launch. */
      const revalidate = fetch(request)
        .then(async (response) => {
          if (response && response.status === 200) {
            await cache.put(request, response.clone());
            await backfillMissingAssets();
          }
          return response;
        })
        .catch(() => undefined);

      if (cached) {
        event.waitUntil(revalidate);
        return cached;
      }

      /* Nothing cached yet (first ever visit): must wait for the network. */
      const fresh = await revalidate;
      return fresh || offlineFallbackPage();
    })());
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
