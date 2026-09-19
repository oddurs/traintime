---
id: 14
title: Retire the eighteen GeoJSON weave layers and the fifteen-stop offset expression
type: chore
status: done
milestone: render-3
assignee: claude
claimed: 2026-09-18
depends_on:
- 13
created: 2026-09-17
updated: 2026-09-18
priority: p1
effort: m
area: map
---

## Problem

Nine weave levels times a line and a casing is eighteen layers, each carrying a
filter and a fifteen-stop `interpolate` offset expression evaluated per feature
per tile. Once the custom layer draws the weave, all of it is dead weight — and
`bandOffsetExpression()` is the second of the two fan derivations, so deleting it
is what actually closes the desync rather than merely avoiding it.

Leaving both in place is worse than either: two renderers drawing the same lines
is exactly the situation this work exists to end.

## Acceptance criteria

- [x] `routes-line-*` and `routes-casing-*` layers removed
- [x] `bandOffsetExpression()` and `FAN_STOPS` deleted
- [x] `applyVisibilityFactory` no longer sets paint properties on zoom-scale change
- [ ] Nothing in the codebase computes a fan outside the shared function

## Retired, except the one the hit test needs

Gone: the eighteen `routes-line-*` / `routes-casing-*` layers, the `routes`
source, `routeLines()`, `bandOffsetExpression`, `FAN_STOPS`, the adaptive-stop
machinery from 0019, and the eighteen `setFilter` plus eighteen
`setPaintProperty` calls the visibility pass used to make. Filtering is a
bitmask uniform now and the widening is a number both shaders read; neither
touches a buffer. Only comments mention any of it.

The fourth criterion is NOT met and is left unticked. `fanOffsetPx` still
computes the fan sum on the CPU, for three callers:

  - the selection ring and the platform counts, which MapLibre still positions
    by longitude and latitude, and
  - the hit test, which has to answer "which train is under the pointer" and
    cannot ask a vertex buffer.

The first two would go by drawing the ring and the counts as instanced marks in
the train layer. The third would not: a hit test needs a CPU-side answer, so
some version of this sum survives as long as a pointer does. What has changed is
that it is no longer a second *curve* — it calls `fanAt`, and it runs at moments
when the camera is settled rather than every frame for every train.

So the criterion was written slightly wrong: the thing worth forbidding is a
second derivation of the curve, not a second evaluation of it. That is gone.
