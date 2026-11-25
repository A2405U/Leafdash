// Offline cache: once loaded at home, the app works in the car with no signal.
// Bump VERSION whenever you change any file so phones pick up the update.
const VERSION = 'leafdash-v79';
const FILES = [
  './', 'index.html', 'style.css', 'manifest.webmanifest',
  'cardata.js', 'settings.js', 'app.js', 'metrics.js', 'didscan.js',
  'car3d.js', 'carimg.js', 'car-rear.webp', 'car-side.webp', 'osmroad.js', 'scenery.js', 'charge.js', 'healthtrip.js', 'driverec.js', 'history.js', 'alerts.js', 'backup.js', 'drive.js', 'dashboard.js', 'addons.js', 'demoroute.js', 'demopanel.js', 'replay.js', 'main.js', 'vendor/mqtt.min.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

// Network first (so updates arrive when online), fall back to cache when offline.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  // Only the app's own files are cached. Requests to other services (ABRP, Home
  // Assistant, map data) go straight out and are never stored on the phone.
  if (new URL(e.request.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(VERSION).then(c => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
