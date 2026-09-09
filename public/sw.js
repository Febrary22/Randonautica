'use strict';

/**
 * Minimal service worker — just enough to satisfy "Add to Home Screen"/install-prompt criteria
 * on Android Chrome and give the app shell a chance to load when offline. It deliberately does
 * NOT cache /api/* — coordinate generation and risk scoring must always hit the live server.
 */

const CACHE_NAME = 'escapade-shell-v1';
const SHELL_FILES = [
  '/',
  '/style.css',
  '/app.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-192-maskable.png',
  '/icons/icon-512-maskable.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {
      // Best-effort: an offline first install (or a flaky network) shouldn't hard-fail activation.
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/')) return; // never cache live game state

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
