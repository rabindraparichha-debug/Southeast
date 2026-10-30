/* Tiffin OS service worker.
 *
 * - Rider mode (/rider) and stock entry (/stock-entry) open without network: their pages are cached
 *   (network first, cache when offline) together with the static files they need.
 * - Static build files are served stale-while-revalidate (they are content-hashed).
 * - Never cached: Supabase API calls (another origin, not intercepted), customer pages (/c/*),
 *   API routes, non-GET requests, and every other dashboard page (they hold customer data; offline
 *   they get a small "you are offline" page instead).
 */
const VERSION = 'v1';
const PAGES = `tiffin-pages-${VERSION}`;
const ASSETS = `tiffin-assets-${VERSION}`;
const SHELL = ['/rider', '/stock-entry'];
const MAX_ASSETS = 300;

self.addEventListener('install', (event) => {
  self.skipWaiting();
  // Best effort: works only when the user is logged in (otherwise the pages redirect to /login).
  event.waitUntil(warm().catch(() => undefined));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith('tiffin-') && k !== PAGES && k !== ASSETS).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  const msg = event.data || {};
  if (msg.type === 'warm') event.waitUntil(warm().catch(() => undefined));
  if (msg.type === 'cache-assets' && Array.isArray(msg.urls)) event.waitUntil(cacheAssets(msg.urls).catch(() => undefined));
  if (msg.type === 'clear-pages') event.waitUntil(caches.delete(PAGES));
});

function isShell(pathname) {
  return SHELL.includes(pathname.replace(/\/$/, '') || '/');
}

function isStaticAsset(url) {
  return (
    url.pathname.startsWith('/_next/static/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname === '/favicon.ico' ||
    url.pathname === '/manifest.webmanifest'
  );
}

function cacheable(res) {
  return res && res.ok && res.type === 'basic' && !res.redirected;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Supabase and every other API: straight to the network
  if (url.pathname === '/c' || url.pathname.startsWith('/c/') || url.pathname.startsWith('/api/')) return;

  if (req.mode === 'navigate') {
    event.respondWith(navigate(req, url));
    return;
  }
  if (isStaticAsset(url)) {
    event.respondWith(staleWhileRevalidate(event, req));
  }
});

async function navigate(req, url) {
  const shell = isShell(url.pathname);
  try {
    const res = await fetch(req);
    if (shell && cacheable(res)) {
      const cache = await caches.open(PAGES);
      await cache.put(url.pathname.replace(/\/$/, ''), res.clone());
    }
    return res;
  } catch {
    if (shell) {
      const cached = await caches.match(url.pathname.replace(/\/$/, ''), { cacheName: PAGES });
      if (cached) return cached;
    }
    return offlinePage(url.pathname);
  }
}

async function staleWhileRevalidate(event, req) {
  const cache = await caches.open(ASSETS);
  const cached = await cache.match(req);
  const update = fetch(req)
    .then(async (res) => {
      if (cacheable(res)) {
        await cache.put(req, res.clone());
        trim(cache);
      }
      return res;
    })
    .catch(() => undefined);
  if (cached) {
    event.waitUntil(update);
    return cached;
  }
  const res = await update;
  return res || new Response('', { status: 504, statusText: 'Offline' });
}

async function trim(cache) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - MAX_ASSETS; i++) await cache.delete(keys[i]);
}

/** Fetches the shell pages (with the user's cookies) and the static files they reference. */
async function warm() {
  const pages = await caches.open(PAGES);
  const assets = new Set();
  for (const path of SHELL) {
    try {
      const res = await fetch(path, { credentials: 'same-origin', cache: 'no-store' });
      if (!cacheable(res)) continue;
      const html = await res.clone().text();
      await pages.put(path, res);
      for (const m of html.matchAll(/\/_next\/static\/[^"'\s)\\]+/g)) assets.add(m[0]);
    } catch {
      // offline or logged out: try again next time
    }
  }
  await cacheAssets([...assets, '/manifest.webmanifest', '/icons/icon-192.png']);
}

async function cacheAssets(urls) {
  const cache = await caches.open(ASSETS);
  await Promise.all(
    urls.map(async (u) => {
      try {
        const url = new URL(u, self.location.origin);
        if (url.origin !== self.location.origin || !isStaticAsset(url)) return;
        if (await cache.match(url.pathname + url.search)) return;
        const res = await fetch(url.pathname + url.search, { credentials: 'same-origin' });
        if (cacheable(res)) await cache.put(url.pathname + url.search, res);
      } catch {
        // ignore
      }
    }),
  );
}

function offlinePage(pathname) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#EA580C">
<title>Offline · Tiffin OS</title>
<style>body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#f8fafc;color:#0f172a;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}
.c{max-width:360px;background:#fff;border-radius:12px;padding:24px;box-shadow:0 1px 2px rgba(0,0,0,.06);border:1px solid #f1f5f9}
h1{font-size:18px;margin:0 0 8px}p{font-size:14px;color:#475569;line-height:1.5}a{display:block;margin-top:10px;padding:10px 14px;border-radius:8px;background:#ea580c;color:#fff;text-decoration:none;text-align:center;font-weight:600}
a.s{background:#fff;color:#1e293b;border:1px solid #e2e8f0}</style></head>
<body><div class="c"><h1>You are offline</h1>
<p>This page needs network. Rider mode and stock entry open without network once you have used them on this device.</p>
<a href="/rider">My stops (rider mode)</a><a class="s" href="/stock-entry">Stock entry</a>
<a class="s" href="${pathname.replace(/[^\w/-]/g, '')}">Try again</a></div></body></html>`;
  return new Response(html, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}
