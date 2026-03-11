// Cache version — increment on deploy to bust all caches
const CACHE_VERSION = 'v3';
const STATIC_CACHE = `static-${CACHE_VERSION}`;
const IMAGE_CACHE = `images-${CACHE_VERSION}`;

// Only truly immutable assets (hashed filenames from Vite build)
const IMMUTABLE_EXTENSIONS = /\.(js|css|woff2?|ttf|eot)$/;
const IMAGE_EXTENSIONS = /\.(png|jpg|jpeg|gif|ico|svg|webp|avif)$/;

// Max image cache age: 24 hours
const IMAGE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// ─── Install ──────────────────────────────────────────────────────────────────
self.addEventListener('install', () => {
  self.skipWaiting();
});

// ─── Activate: clean up old caches ───────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((key) => {
          if (key !== STATIC_CACHE && key !== IMAGE_CACHE) {
            console.log('[SW] Deleting old cache:', key);
            return caches.delete(key);
          }
        })
      )
    ).then(() => self.clients.claim())
  );
});

// ─── Fetch ────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle GET
  if (request.method !== 'GET') return;

  // Skip Vite HMR and dev resources
  if (
    url.search.includes('t=') ||
    url.pathname.includes('/src/') ||
    url.pathname.includes('/@') ||
    url.pathname.includes('/node_modules/')
  ) return;

  // Skip API calls — never cache, always network
  if (
    url.pathname.startsWith('/api') ||
    url.pathname.startsWith('/core') ||
    url.pathname.includes('/graphql')
  ) return;

  // Skip cross-origin
  if (url.origin !== self.location.origin) return;

  // ── HTML / navigation: network-first, offline fallback ───────────────────
  if (request.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname === '/') {
    event.respondWith(networkFirstWithOfflineFallback(request));
    return;
  }

  // ── Immutable static assets (hashed JS/CSS/fonts): cache-first ───────────
  if (IMMUTABLE_EXTENSIONS.test(url.pathname)) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }

  // ── Images: stale-while-revalidate with 24h max age ──────────────────────
  if (IMAGE_EXTENSIONS.test(url.pathname)) {
    event.respondWith(staleWhileRevalidateImages(request));
    return;
  }
});

// ─── Strategy: network-first (HTML) ──────────────────────────────────────────
async function networkFirstWithOfflineFallback(request) {
  try {
    const response = await fetch(request, { cache: 'no-store' });
    if (response.ok) {
      // Cache a fresh copy of index.html for the offline fallback only
      const cache = await caches.open(STATIC_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // Network failed — app is offline or server is down
    const cached = await caches.match(request) || await caches.match('/index.html');
    if (cached) {
      // Inject an offline banner into the cached page
      const text = await cached.text();
      const modified = injectOfflineBanner(text);
      return new Response(modified, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }
    return offlinePageResponse();
  }
}

// ─── Strategy: cache-first for immutable assets ──────────────────────────────
async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('Asset unavailable', { status: 503 });
  }
}

// ─── Strategy: stale-while-revalidate for images (with TTL) ──────────────────
async function staleWhileRevalidateImages(request) {
  const cache = await caches.open(IMAGE_CACHE);
  const cached = await cache.match(request);

  if (cached) {
    const cachedDate = new Date(cached.headers.get('sw-cached-at') || 0);
    const age = Date.now() - cachedDate.getTime();

    // Revalidate in background if older than 24h
    if (age > IMAGE_MAX_AGE_MS) {
      fetchAndCacheImage(request, cache);
    }
    return cached;
  }

  return fetchAndCacheImage(request, cache);
}

async function fetchAndCacheImage(request, cache) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const headers = new Headers(response.headers);
      headers.set('sw-cached-at', new Date().toISOString());
      const modified = new Response(await response.blob(), { headers });
      cache.put(request, modified);
      return modified;
    }
    return response;
  } catch {
    return new Response('Image unavailable', { status: 503 });
  }
}

// ─── Offline banner injected into cached HTML ─────────────────────────────────
function injectOfflineBanner(html) {
  const banner = `
<style>
  #sw-offline-banner {
    position: fixed; top: 0; left: 0; right: 0; z-index: 99999;
    background: #ef4444; color: white;
    padding: 10px 16px; font-size: 13px; font-weight: 600;
    text-align: center; letter-spacing: 0.01em;
    display: flex; align-items: center; justify-content: center; gap: 8px;
    box-shadow: 0 2px 12px rgba(0,0,0,0.25);
  }
  #sw-offline-banner button {
    background: rgba(255,255,255,0.25); border: none; color: white;
    padding: 3px 10px; border-radius: 6px; font-size: 12px;
    font-weight: 700; cursor: pointer; margin-left: 8px;
  }
</style>
<div id="sw-offline-banner">
  ⚠ Server unavailable — you are viewing cached content.
  <button onclick="window.location.reload()">Retry</button>
</div>`;
  return html.replace('<body', banner + '<body');
}

// ─── Fallback offline page ────────────────────────────────────────────────────
function offlinePageResponse() {
  return new Response(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Offline</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      min-height: 100vh; display: flex; align-items: center; justify-content: center;
      background: #0f172a; color: #f1f5f9;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      padding: 24px;
    }
    .card {
      text-align: center; max-width: 360px; width: 100%;
      background: #1e293b; border-radius: 20px; padding: 40px 32px;
      border: 1px solid rgba(255,255,255,0.08);
      box-shadow: 0 25px 50px rgba(0,0,0,0.4);
    }
    .icon { font-size: 56px; margin-bottom: 20px; }
    h1 { font-size: 22px; font-weight: 700; margin-bottom: 10px; }
    p { color: #94a3b8; font-size: 14px; line-height: 1.6; margin-bottom: 28px; }
    button {
      background: #6366f1; color: white; border: none; padding: 12px 28px;
      border-radius: 12px; font-size: 15px; font-weight: 600; cursor: pointer;
      width: 100%; transition: opacity 0.2s;
    }
    button:hover { opacity: 0.85; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">📡</div>
    <h1>Server Unavailable</h1>
    <p>The server is currently unreachable. This may be a temporary outage. Please try again in a moment.</p>
    <button onclick="window.location.reload()">Try Again</button>
  </div>
</body>
</html>`, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    status: 503,
  });
}

// ─── Push Notifications ───────────────────────────────────────────────────────
self.addEventListener('push', (event) => {
  const data = event.data?.json() || {};
  event.waitUntil(
    self.registration.showNotification(data.title || 'Notification', {
      body: data.body || '',
      icon: '/icons/icon-192x192.png',
      badge: '/icons/icon-192x192.png',
      vibrate: [100, 50, 100],
      data: { url: data.url || '/' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data.url));
});
