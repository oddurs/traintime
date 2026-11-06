---
id: 26
uid: a02d432c-9e4e-4a39-950e-1276eaa6bebd
title: 'Map: cut main-thread cost per frame'
type: chore
status: done
created: 2026-11-05
updated: 2026-11-05
priority: p2
area: map
effort: s
---

## Problem

At street zoom the ribbons, the ±1σ "where it might be" bands, were re-uploaded on every frame
of a throttled phone: 1.00 uploads a frame at zoom 16 on a 4× CPU. That was half the main thread,
38.6 ms a frame against 14.5 with no ribbons at all. Below zoom 12.5 they were uploaded a third of
the time for a layer that does not draw.

## Proposal

Give ribbons their own clock, moving them by their 3 px blur instead of 0.4 px, and upload nothing
when they cannot be seen.

## Acceptance criteria

- [x] Ribbon uploads per frame at zoom 16 well under 1.00 (now 0.23–0.43)
- [x] No ribbon uploads below the layer's minzoom (0.00 at zoom 11 idle and pan)
- [x] Main-thread ms per frame at zoom 16, 4× CPU, measured before and after in `docs/RENDER.md`
- [x] Ribbons still draw (checked by screenshot at zoom 15.5), with no console errors
