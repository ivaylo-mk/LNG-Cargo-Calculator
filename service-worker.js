/*
 * Service worker for the LNG Cargo Properties Calculator.
 *
 * Caches:
 *   - SHELL_CACHE (unversioned): the files needed to start the app —
 *     './' and './index.html'. Refreshed on updates but NEVER deleted, so
 *     the last known working app survives version changes.
 *   - ASSET_CACHE (versioned): manifest, icons, and the standalone file.
 *     Best-effort; a missing asset never prevents offline startup.
 *
 * Updates are fail-safe: new shell files are downloaded and verified in
 * full before any of them replaces the cached copy. An interrupted or
 * failed update leaves the existing working shell untouched.
 *
 * Navigations are cache-first: a cold launch starts from the cached shell
 * with no network request. The latest version is fetched in the
 * background and used from the next launch.
 *
 * Cleanup deletes only this app's own outdated caches (by prefix), never
 * the shell cache and never caches belonging to anything else.
 */
const VERSION = 'v2.6.4';
const PREFIX = 'lng-cargo-';
const SHELL_CACHE = PREFIX + 'shell';
const ASSET_CACHE = PREFIX + 'assets-' + VERSION;

const SHELL_ASSETS = [
  './',
  './index.html'
];

const OPTIONAL_ASSETS = [
  './LNG_Cargo_Properties_Calculator.html',
  './manifest.json',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];

/* A response is safe to store as the app shell only if it is a complete,
   same-origin HTML page. Guards against caching an error page or a
   redirect in place of the working app. */
function isGoodShell(response) {
  if (!response || response.status !== 200 || response.type !== 'basic') return false;
  const type = response.headers.get('content-type') || '';
  return type.indexOf('text/html') !== -1;
}

/* Strip the query string so the shell is stored under a stable key and
   repeated launches with different query strings do not accumulate. */
function shellKey(url) {
  const u = new URL(url, self.location.href);
  u.search = '';
  u.hash = '';
  return u.href;
}

/* Staged, all-or-nothing shell update. Every shell file is fetched fresh
   (bypassing the HTTP cache) and verified first; only when all of them
   are good are they written into the shell cache. Any failure throws
   before a single cached file is replaced. */
async function stageShell() {
  const fetched = await Promise.all(SHELL_ASSETS.map(async (url) => {
    const response = await fetch(new Request(url, { cache: 'reload' }));
    if (!isGoodShell(response)) throw new Error('Shell asset invalid: ' + url);
    return [shellKey(url), response];
  }));
  const cache = await caches.open(SHELL_CACHE);
  await Promise.all(fetched.map(([key, response]) => cache.put(key, response)));
}

async function cacheOptionalAssets() {
  const cache = await caches.open(ASSET_CACHE);
  await Promise.all(OPTIONAL_ASSETS.map((url) =>
    cache.add(new Request(url, { cache: 'reload' })).catch((err) => {
      console.warn('[SW] Optional asset not cached:', url, err);
    })
  ));
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    /* If staging fails, install fails: the current worker and its shell
       stay in use, and the update is retried on a later visit. */
    await stageShell();
    await cacheOptionalAssets();
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((k) => k.indexOf(PREFIX) === 0 && k !== SHELL_CACHE && k !== ASSET_CACHE)
      .map((k) => caches.delete(k)));
    await backfillMissingAssets();
    await self.clients.claim();
  })());
});

/* Re-attempt any asset not currently cached. Runs on activation and after
   successful online launches, so a one-off download failure is repaired
   on later use. A complete cache generates no network traffic. */
async function backfillMissingAssets() {
  const shell = await caches.open(SHELL_CACHE);
  let shellComplete = true;
  for (const url of SHELL_ASSETS) {
    if (!(await shell.match(shellKey(url)))) { shellComplete = false; break; }
  }
  if (!shellComplete) {
    await stageShell().catch((err) => {
      console.warn('[SW] Shell backfill failed, will retry:', err);
    });
  }
  const assets = await caches.open(ASSET_CACHE);
  await Promise.all(OPTIONAL_ASSETS.map(async (url) => {
    if (await assets.match(url, { ignoreSearch: true })) return;
    return assets.add(url).catch((err) => {
      console.warn('[SW] Asset backfill failed, will retry:', url, err);
    });
  }));
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;

  /* ── Navigations: cache-first from the shell, revalidated in background ── */
  if (request.mode === 'navigate' || request.destination === 'document') {
    event.respondWith((async () => {
      const shell = await caches.open(SHELL_CACHE);
      const cached = await shell.match(shellKey(request.url))
                  || await shell.match(shellKey('./index.html'))
                  || await shell.match(shellKey('./'))
                  || await caches.match(request, { ignoreSearch: true });

      const revalidate = fetch(request)
        .then(async (response) => {
          if (isGoodShell(response)) {
            await shell.put(shellKey(request.url), response.clone());
            await backfillMissingAssets();
          }
          return response;
        })
        .catch(() => undefined);

      if (cached) {
        event.waitUntil(revalidate);
        return cached;
      }

      /* Nothing cached at all (first ever visit): wait for the network. */
      const fresh = await revalidate;
      return fresh || offlineFallbackPage();
    })());
    return;
  }

  /* ── Static assets: cache-first, then network ── */
  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((response) => {
          if (response && response.status === 200 && response.type === 'basic') {
            const clone = response.clone();
            caches.open(ASSET_CACHE).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() =>
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
    'Connect to the internet and open the app once to make it available offline.</p></body>',
    { headers: { 'Content-Type': 'text/html' } }
  );
}
