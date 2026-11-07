---
id: 56
uid: 7cb0ecde-cdb7-496e-ad55-a7f26f47b8ad
title: Departure board mode for a screen in a lobby or a café
type: feature
status: backlog
milestone: reach
created: 2026-11-07
updated: 2026-11-07
priority: p2
effort: m
area: site
---

## Problem

The embed (src/app/embed/page.tsx) is a small card for a web page. A screen on a wall needs
something else: one or two stations, large enough to read across a room, no interaction, and
running for weeks without anyone touching it.

## Proposal

`/board/?s=L08&s=A24` shows one column per station:

- the next trains per direction, with the countdown in the clock role, scaled to the screen;
- a slow drift of the layout to avoid burn-in;
- reconnection on its own, and a "Reconnecting" line rather than a frozen board;
- a reload once a night, to pick up deploys.

## Acceptance criteria

- [ ] readable at 5 metres on a 1080p screen: the countdown is at least 6 % of the screen height
- [ ] left running for 24 hours in a headless browser against the live poller, it shows current trains at the end with no manual action
- [ ] losing the connection for 5 minutes shows "Reconnecting" and recovers on its own
