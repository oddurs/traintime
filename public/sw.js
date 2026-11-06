/**
 * traintime service worker: keeps the app shell available offline and instant on repeat visits.
 * Live data is never cached — a stale train is worse than no train.
 *
 * The cache name carries the build. It used to be a hard-coded "traintime-v1", which meant the
 * `activate` handler below — whose whole job is to delete caches that are not the current one —
 * never deleted anything, for any deploy, ever. Two things followed from that, and both of them
 * looked like the map being broken rather than like a cache:
 *
 *  - network.json was cached first and never revisited. Its URL does not change between builds, so
 *    a browser that cached it kept that copy for good. The band layout the map is drawn from lives
 *    in that file and has gained fields since — a browser holding the file from 30 August drew the
 *    whole subway as 207 strokes on one centreline instead of 2950 in their own lanes.
 *  - the shell entries kept their old chunk URLs. Those chunks are removed by the next deploy, so
 *    a document served from cache could reference files that now 404 and the app would not boot.
 *
 * Stamped per build, `activate` clears both. Everything below is now either genuinely immutable
 * under its URL or revalidated in the background.
 */
const CACHE = "traintime-__BUILD__";
const SCOPE = new URL(self.registration.scope).pathname;

/*
 * Only the shell is fetched at install. network.json used to be too, which on a first visit sent it
 * twice — once here, once when the page asked for it, a revalidation of the copy this had just
 * stored — 105 KB of a slow link spent beside the map engine the page was waiting for. The page
 * always asks for it, and the stale-while-revalidate rule below keeps the copy it gets.
 */
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll([SCOPE]).catch(() => {})).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/**
 * Hashed build assets, and the map engine under its version number: the URL changes when the
 * contents do, so the cache can be trusted.
 */
const isImmutable = (url) => url.pathname.startsWith(`${SCOPE}_next/static/`) || url.pathname.startsWith(`${SCOPE}maplibre/`);

/**
 * Files whose URL stays the same while their contents change with a deploy: the network the map is
 * drawn from, the timing tables, the feed schema. Served from cache for
 * speed and replaced in the background, so a deploy reaches a returning visitor on their next load
 * rather than never.
 */
const isData = (url) => url.pathname.endsWith("/data/network.json")
  || url.pathname.endsWith("/data/network-lite.json")
  || url.pathname.endsWith("/data/poster.svg")
  || url.pathname.endsWith("/data/timing.json") || url.pathname.endsWith("/data/nyct-subway.proto");

const store = (request, res) => {
  if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(request, copy)); }
  return res;
};

self.addEventListener("fetch", (e) => {
  const { request } = e;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;      // MTA feeds and map tiles: always live
  if (url.pathname.includes("/api/")) return;           // poller: always live

  if (isImmutable(url)) {
    e.respondWith(caches.match(request).then((hit) => hit ?? fetch(request).then((res) => store(request, res))));
    return;
  }

  // Stale while revalidate: answer from cache at once, and fetch a fresh copy for next time.
  if (isData(url)) {
    e.respondWith(
      caches.match(request).then((hit) => {
        const live = fetch(request).then((res) => store(request, res)).catch(() => hit);
        return hit ?? live;
      }),
    );
    return;
  }

  // Documents: network first so a deploy lands immediately, cache as the offline fallback.
  if (request.mode === "navigate") {
    e.respondWith(
      fetch(request)
        .then((res) => store(request, res))
        .catch(() => caches.match(request).then((hit) => hit ?? caches.match(SCOPE))),
    );
  }
});
