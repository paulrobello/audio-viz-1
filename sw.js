// RESOMANCE service worker — cache-first for a fully offline, installable PWA.
// The app is self-contained (no CDN/font/image deps), so the asset list is tiny.
const CACHE = 'resomance-v6';   // bump on any index.html change so cache-first serves the new build
const ASSETS = ['./', './index.html', './manifest.webmanifest', './og.jpg', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(cached => cached ||
      fetch(e.request).then(resp => {
        const cp = resp.clone();
        caches.open(CACHE).then(c => c.put(e.request, cp));
        return resp;
      }).catch(() => caches.match('./index.html')))
  );
});
