/**
 * traintime service worker: keeps the app shell available offline and instant on repeat visits.
 * Live data is never cached — a stale train is worse than no train.
 */
const CACHE = "traintime-v1";
const SCOPE = new URL(self.registration.scope).pathname;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll([SCOPE, `${SCOPE}data/network.json`]).catch(() => {})).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const isShell = (url) => url.pathname.startsWith(`${SCOPE}_next/static/`) || url.pathname.endsWith("/data/network.json")
  || url.pathname.endsWith("/data/timing.json") || url.pathname.endsWith("/data/nyct-subway.proto")
  || url.pathname.endsWith("/maplibre/maplibre-gl-worker.mjs");

self.addEventListener("fetch", (e) => {
  const { request } = e;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;      // MTA feeds and map tiles: always live
  if (url.pathname.includes("/api/")) return;           // poller: always live

  // Hashed build assets and the static network never change under a URL: cache first.
  if (isShell(url)) {
    e.respondWith(
      caches.match(request).then((hit) =>
        hit ?? fetch(request).then((res) => {
          if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(request, copy)); }
          return res;
        }),
      ),
    );
    return;
  }

  // Documents: network first so a deploy lands immediately, cache as the offline fallback.
  if (request.mode === "navigate") {
    e.respondWith(
      fetch(request)
        .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(request, copy)); return res; })
        .catch(() => caches.match(request).then((hit) => hit ?? caches.match(SCOPE))),
    );
  }
});
