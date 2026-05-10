// ── Wallet Service Worker ──
// Caches the app shell for offline use
// Cache busts on new deploy via CACHE_VERSION

const CACHE_VERSION = 'wallet-v1';
const CACHE_STATIC  = 'wallet-static-v1';

// Files to cache for offline shell
const SHELL_FILES = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/manifest.json',
  '/Assets/l_logo.png',
  '/Assets/d_logo.png',
  '/Assets/fav.png',
  'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&display=swap'
];

// ── INSTALL: cache app shell ──
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_STATIC).then(cache => {
      return cache.addAll(SHELL_FILES).catch(err => {
        console.warn('SW: Some files failed to cache:', err);
      });
    }).then(() => self.skipWaiting())
  );
});

// ── ACTIVATE: clean old caches ──
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_STATIC)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ── FETCH: serve from cache, fallback to network ──
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Never intercept Google Apps Script API calls — always live
  if (url.hostname === 'script.google.com') return;
  // Never intercept Google Fonts (they have their own cache)
  if (url.hostname === 'fonts.gstatic.com') return;

  // For navigation requests (HTML pages): network first, fallback to cache
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .catch(() => caches.match('/index.html'))
    );
    return;
  }

  // For everything else: cache first, fallback to network
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(response => {
        // Cache successful GET responses
        if (response && response.status === 200 && e.request.method === 'GET') {
          const clone = response.clone();
          caches.open(CACHE_STATIC).then(cache => cache.put(e.request, clone));
        }
        return response;
      });
    })
  );
});