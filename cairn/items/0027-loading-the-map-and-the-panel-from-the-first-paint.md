---
id: 27
uid: 313faebd-7814-423c-b8fd-d3691d5336dc
title: 'Loading: the map and the panel from the first paint'
type: feature
status: done
created: 2026-11-06
updated: 2026-11-06
closed_at: 2026-11-06
priority: p2
area: front-end
effort: m
---

## Problem

Filmed at one frame a second on slow 4G with a 4× CPU, a phone saw:

- 0–2 s: a black screen with "loading the network…" in small grey type.
- 3–5 s: the sheet reading "0 trains · poller · live feeds" under a Live chip, before any train had arrived, over a black void.
- ~6 s: the placeholder bars collapsing, so the sheet jumped about 76 px.
- ~7 s: the lines appearing on black, then the basemap popping in under them two seconds later.

A failed fetch of either network file ended in `.catch(() => {})`: "loading" forever, or a map that never came, with nothing to press. A station opened from a saved place said "No trains approaching right now" before the first trains arrived.

## Proposal

- The panel renders before the network: real bullets, from the trunk colours, and a search field that takes input and searches it when the names land.
- The sheet is a sheet in the HTML, so a phone never draws the desktop panel first.
- A poster of the network at the home view (`scripts/build-poster.ts`, about 12 KB brotli) is in the first paint, placed exactly where the map will draw. The map fades in over it once its lines are up and the basemap is in, or 2.5 s after the lines.
- The status says what is actually happening: Connecting, then Live. Past 8 s it says the connection is slow. An empty board while waiting says so.
- A head script hides a dismissed legend and holds the saved list's measured height before React runs.
- Both fetches fail visibly, with Try again, and retry when the browser comes back online.

## Acceptance criteria

- [x] From the first paint, a phone on slow 4G shows the panel and the network, with no black screen and no layout jump as data arrives (filmed)
- [x] The foot and chip never claim live trains before the first snapshot (test)
- [x] A failed stations or map fetch shows an error with Try again (filmed with the URL blocked)
- [x] A returning visitor's saved list and dismissed legend do not move the sheet at hydration (filmed)
- [x] Deployed, and the slow-4G audit run against the live site

## 2026-11-06

Live 2026-11-06, slow-4G, 4x CPU, --no-sw, three runs: first paint 2.2-2.5 s with the panel and poster, readable 5.2-5.3 s, map canvas 15.1-15.3 s, map shown 16.5-16.7 s, 513 KB over 25 requests. Filmed live: panel and poster from frame 1, sheet steady, Connecting to Live, map over the poster's lines.
