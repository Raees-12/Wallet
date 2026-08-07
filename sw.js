// ── Wallet Service Worker ──
// Scoped to the site root for Vercel deployment.
//
// Strategy: network-first for everything same-origin (HTML/JS/CSS), falling
// back to cache only when offline. This is the important fix — a cache-first
// strategy here means installed/PWA users keep seeing old code forever after
// every update, since app.js/index.html rarely change bytes-for-bytes in a
// way that forces a fresh fetch. Network-first trades a tiny bit of speed for
// always getting the latest version when online, which matters far more for
// an actively-developed app. Icons/images still use cache-first since they
// almost never change.

const CACHE_NAME = 'wallet-v14'; // bump this on every sw.js change to force clients to update
const BASE = '/';

const SHELL_FILES = [
  BASE,
  BASE + 'index.html',
  BASE + 'style.css',
  BASE + 'app.js',
  BASE + 'manifest.json',
  BASE + 'Assets/l_logo.png',
  BASE + 'Assets/d_logo.png',
  BASE + 'Assets/fav.png',
  BASE + 'Assets/shortcuts/expense.png',
  BASE + 'Assets/shortcuts/income.png',
  BASE + 'Assets/shortcuts/loan.png',
  BASE + 'Assets/shortcuts/report.png',
];

const CACHE_FIRST_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.svg', '.ico', '.webp'];

// ── INSTALL ──
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL_FILES).catch(err => console.warn('Cache partial fail:', err)))
      .then(() => self.skipWaiting()) // take over immediately, don't wait for tabs to close
  );
});

// ── ACTIVATE: remove old caches ──
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim()) // control already-open tabs right away
  );
});

// ── FETCH ──
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Never intercept API calls or external fonts
  if (url.pathname.startsWith('/api/')) return;
  if (url.hostname === 'fonts.gstatic.com') return;
  if (url.hostname === 'fonts.googleapis.com') return;
  if (url.origin !== self.location.origin) return;

  const isImage = CACHE_FIRST_EXTENSIONS.some(ext => url.pathname.toLowerCase().endsWith(ext));

  if (isImage) {
    // Images: cache-first (fine — these basically never change)
    e.respondWith(
      caches.match(e.request).then(cached => cached || fetch(e.request).then(response => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        }
        return response;
      }))
    );
    return;
  }

  // Everything else (HTML/JS/CSS/manifest): network-first, cache is just the offline fallback
  e.respondWith(
    fetch(e.request).then(response => {
      if (response && response.status === 200 && e.request.method === 'GET') {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
      }
      return response;
    }).catch(() =>
      caches.match(e.request).then(cached => cached || (e.request.mode === 'navigate' ? caches.match(BASE + 'index.html') : undefined))
    )
  );
});
