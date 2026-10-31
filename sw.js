/* Version substituted with Git commit SHA by GitHub Actions. Never cache Firestore/Auth API calls. */
const BUILD_ID = '__BUILD_ID__';
const STATIC_CACHE = 'zmina-static-' + BUILD_ID;
const SDK_CACHE = 'zmina-firebase-sdk-v13.1.0';
const APP_ASSETS = [
  './', './index.html', './auth.html', './admin.html', './styles.css',
  './logic.js', './app.js', './auth.js', './admin.js', './admin-metrics.js', './cloud.js',
  './firebase-config.js', './pwa.js', './favicon.svg', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-512-maskable.png'
];
const SDK_ROOT = 'https://www.gstatic.com/firebasejs/13.1.0/';
const SDK_START = ['firebase-app.js', 'firebase-auth.js', 'firebase-firestore.js'];

// Proactively cache the Firebase ESM dependency graph for the first offline launch.
// Best-effort: an unavailable SDK/CDN must never prevent the local app shell from installing.
async function cacheFirebaseModules() {
  const cache = await caches.open(SDK_CACHE);
  const queued = SDK_START.map(name => SDK_ROOT + name);
  const visited = new Set();
  let count = 0;
  const deadline = Date.now() + 8500; // Never hold up installation indefinitely on a slow CDN.
  while (queued.length && count < 120 && Date.now() < deadline) {
    const batch = queued.splice(0, 6).filter(url => {
      if (visited.has(url)) return false;
      visited.add(url); return true;
    });
    if (!batch.length) continue;
    await Promise.all(batch.map(async url => {
      try {
        const request = new Request(url, {mode:'cors'});
        let response = await cache.match(request);
        if (!response) {
          response = await fetch(request, {signal: AbortSignal.timeout(Math.max(500, deadline - Date.now()))});
          if (!response.ok || response.type === 'opaque') return;
          await cache.put(request, response.clone());
        }
        // ESM SDK imports are same-version HTTPS modules. Follow only this pinned SDK root.
        const source = await response.text();
        const imports = /\b(?:import|export)\s*(?:(?:[^'";]*?)\s+from\s*)?['"]([^'"\n]+)['"]|\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g;
        for (const match of source.matchAll(imports)) {
          const specifier = match[1] || match[2];
          const resolved = new URL(specifier, url);
          if (resolved.href.startsWith(SDK_ROOT) && resolved.pathname.endsWith('.js') && !visited.has(resolved.href)) queued.push(resolved.href);
        }
      } catch { /* cache files already loaded via the browser on subsequent online visits */ }
    }));
    count += batch.length;
  }
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const shell = await caches.open(STATIC_CACHE);
    await shell.addAll(APP_ASSETS.map(path => new Request(new URL(path, self.registration.scope), {cache:'reload'})));
    await cacheFirebaseModules();
    // Do not force activation until the client confirms there are no unsynced edits.
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith('zmina-static-') && key !== STATIC_CACHE).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

async function sameOriginNetworkFirst(request) {
  const cache = await caches.open(STATIC_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok && response.type !== 'opaque') await cache.put(request, response.clone());
    return response;
  } catch {
    const cached = await cache.match(request, {ignoreSearch:true});
    if (cached) return cached;
    if (request.mode === 'navigate') {
      const path = new URL(request.url).pathname;
      if (path.endsWith('/') || path.endsWith('/index.html')) return (await cache.match(new URL('./index.html', self.registration.scope)));
    }
    return Response.error();
  }
}
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // No application data or authentication tokens enter Cache Storage.
  if (url.origin === self.location.origin) {
    if (!url.pathname.startsWith(new URL(self.registration.scope).pathname)) return;
    if (url.pathname.endsWith('/version.json')) return; // always network-only for fresh deployments
    event.respondWith(sameOriginNetworkFirst(request));
  } else if (url.href.startsWith(SDK_ROOT) && url.pathname.endsWith('.js')) {
    event.respondWith((async () => {
      const cache = await caches.open(SDK_CACHE);
      const cached = await cache.match(request);
      if (cached) return cached;
      try {
        const response = await fetch(request);
        if (response.ok && response.type !== 'opaque') await cache.put(request, response.clone());
        return response;
      } catch { return Response.error(); }
    })());
  }
});
