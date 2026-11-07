---
id: 47
uid: 9911ec46-6291-45f2-b54f-f7b4d66a4e58
title: Open with no connection
type: feature
status: backlog
milestone: ride
created: 2026-11-07
updated: 2026-11-07
priority: p1
effort: m
area: platform
---

## Problem

Underground, the app is often opened with no signal. The service worker (public/sw.js) caches
only the app shell at install, and serves the network files stale-while-revalidate. Nobody has
checked what a rider actually sees when the app is opened with no connection.

## Proposal

- Make an offline open work end to end:
  - the shell, the JavaScript chunks for the page, network-lite.json and poster.svg are cached
    on the first visit;
  - an offline open draws the card, the saved stations and the poster;
  - the status badge reads "Offline".
- Live data is never served from the cache: a stale train is worse than none (the sw.js rule).

## Acceptance criteria

- [ ] after one online visit, reloading in airplane mode shows the card, search over station names, the saved stations and an "Offline" badge, with no error page
- [ ] reconnecting brings live trains back without a reload
- [ ] audit-ui gains an offline step that checks the first criterion
