// ── Wallet Service Worker ──
// Scoped to /Wallet/ for GitHub Pages: raees-12.github.io/Wallet/

const CACHE_NAME = 'wallet-v1';
const BASE = '/Wallet/';

const SHELL_FILES = [
  BASE,
  BASE + 'index.html',
  BASE + 'style.css',
  BASE + 'app.js',
  BASE + 'manifest.json',
  BASE + 'Assets/l_logo.png',
  BASE + 'Assets/d_logo.png',
  BASE + 'Assets/fav.png',
];

// ── INSTALL ──
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL_FILES).catch(err => console.warn('Cache partial fail:', err)))
      .then(() => self.skipWaiting())
  );
});

// ── ACTIVATE: remove old caches ──
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ── FETCH ──
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Never intercept API calls or external fonts
  if (url.hostname === 'script.google.com') return;
  if (url.hostname === 'fonts.gstatic.com') return;
  if (url.hostname === 'fonts.googleapis.com') return;

  // Navigation: network first, fallback to cached index.html
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).catch(() => caches.match(BASE + 'index.html'))
    );
    return;
  }

  // Static assets: cache first, fallback to network
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(response => {
        if (response && response.status === 200 && e.request.method === 'GET') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        }
        return response;
      });
    })
  );
});
