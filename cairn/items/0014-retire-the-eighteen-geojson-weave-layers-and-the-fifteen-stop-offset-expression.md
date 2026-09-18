---
id: 14
title: Retire the eighteen GeoJSON weave layers and the fifteen-stop offset expression
type: chore
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

## Problem

Nine weave levels times a line and a casing is eighteen layers, each carrying a
filter and a fifteen-stop `interpolate` offset expression evaluated per feature
per tile. Once the custom layer draws the weave, all of it is dead weight — and
`bandOffsetExpression()` is the second of the two fan derivations, so deleting it
is what actually closes the desync rather than merely avoiding it.

Leaving both in place is worse than either: two renderers drawing the same lines
is exactly the situation this work exists to end.

## Acceptance criteria

- [ ] `routes-line-*` and `routes-casing-*` layers removed
- [ ] `bandOffsetExpression()` and `FAN_STOPS` deleted
- [ ] `applyVisibilityFactory` no longer sets paint properties on zoom-scale change
- [ ] Nothing in the codebase computes a fan outside the shared function
