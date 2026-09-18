---
id: 15
title: Casing margin drifts because width and offset sample different curves
type: bug
status: backlog
milestone: render-3
depends_on:
- 13
created: 2026-09-17
updated: 2026-09-17
priority: p1
effort: m
area: map
---

## What happens

The casing interpolates `10 -> 2.3, 13 -> 3.9, 16 -> 6.6` and the stroke
`10 -> 1.1, 13 -> 2.3, 16 -> 4.2` (TrainMap.tsx:507, :517) — three stops each.
The offset interpolates across fifteen (`FAN_STOPS`, layout.ts:142). Between
stops, two piecewise-linear approximations of two different curves diverge, so
the casing margin breathes and the band spacing moves against it as you zoom.

The margin should be a stated quantity — "the casing reads one and a half pixels
wider than the stroke" — not an emergent difference between two interpolations.

## Acceptance criteria

- [ ] Casing width is derived from stroke width plus a stated margin
- [ ] Both are continuous functions of zoom, with no stop table
- [ ] The margin holds to within a pixel across zoom 10 to 20, checked by sampling
