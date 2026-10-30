'use strict';

// Service worker d'ICE MANAGER (application installable).
// - L'interface (HTML, JS, CSS, icônes) est mise en cache : l'application s'ouvre même avec un réseau faible.
//   Réseau d'abord, cache en secours : une nouvelle version déployée est prise dès qu'on est en ligne.
// - Les données (/api/…) ne sont jamais mises en cache : ventes, paiements et stock viennent toujours du serveur.

const CACHE = 'ice-manager-v1';
const SHELL = [
  './', 'index.html', 'app.js', 'style.css', 'manifest.webmanifest',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    } catch (err) {
      const cached = await caches.match(req, { ignoreSearch: true })
        ?? (req.mode === 'navigate' ? await caches.match('index.html') : undefined);
      if (cached) return cached;
      throw err;
    }
  })());
});
