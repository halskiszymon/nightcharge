// Shell: stale-while-revalidate — serve from cache for instant open, refresh
// in the background so the next open runs the new version (no manual cache
// busting). Data: network-first, cache fallback shows the last known state.
const SHELL = 'shell-v2';
const DATA = 'data-v1';
const SHELL_FILES = ['.', 'index.html', 'app.js', 'manifest.webmanifest', 'settings.html'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => ![SHELL, DATA].includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.includes('/data/') || url.pathname.endsWith('config.json')) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(DATA).then((c) => c.put(e.request, copy));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
  } else {
    e.respondWith(
      caches.match(e.request).then((hit) => {
        const refresh = fetch(e.request)
          .then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(SHELL).then((c) => c.put(e.request, copy));
            }
            return res;
          })
          .catch(() => hit);
        return hit || refresh;
      })
    );
  }
});
