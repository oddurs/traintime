---
id: 23
uid: 6c192c54-1460-465a-b64f-2f4207abb63e
title: 'Front-end: measure and cut load and gesture cost'
type: chore
status: doing
created: 2026-11-05
updated: 2026-11-05
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
- [ ] Deployed, and the slow-4G audit run against the live site
