---
id: 23
uid: 6c192c54-1460-465a-b64f-2f4207abb63e
title: 'Front-end: measure and cut load and gesture cost'
type: chore
status: done
created: 2026-11-05
updated: 2026-11-06
closed_at: 2026-11-06
priority: p2
area: site
effort: m
---

## What happens

On slow 4G with a 4× CPU throttle, the map appeared 21–27 s after load. The weight audit said 13 s
and 268 KB, but it did not count bytes the service worker fetched or throttle them, and it ran with
the HTTP cache disabled. Its local server also sent `.mjs` with the wrong MIME type, so MapLibre's
worker never ran.

Each first visit downloaded the following more than it needed to, mostly on the way to the map:

- MapLibre's 138 KB shared module twice: bundled into the page's chunk, and fetched again by the
  worker.
- `network.json` (105 KB) twice: the service worker precached it, then revalidated it when the
  page asked for it.
- The map engine (260 KB) only after `network.json` had arrived and been parsed.
- The 87 KB alerts feed at the same time as the engine, sharing the link with it.

## Proposal

Fix the audit first, then each of the above, measured against the base build on the same machine.

## Acceptance criteria

- [x] The weight audit counts every byte the site sends, including worker requests, and reports when the map is ready
- [x] A first visit downloads each MapLibre module and `network.json` once
- [x] The engine and the geometry are requested together; alerts wait for the map
- [x] The map renders with no console errors, exceptions or failed requests
- [x] Deployed, and the slow-4G audit run against the live site

## 2026-11-06

Live, 2026-11-06, slow-4G, 4x CPU, --no-sw, three runs: readable 4.7/4.9/5.1 s, map canvas 14.7/15.0/15.5 s (median 15.0 s), style loaded 16.5-18.2 s, 499 KB over 24 requests. No console errors. A trailing slash on the URL made the audit measure an error page; fixed in the same PR.
