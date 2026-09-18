---
id: 12
title: Bake the segments into a static vertex buffer with per-vertex tangent and band
type: feature
status: backlog
milestone: render-3
created: 2026-09-17
updated: 2026-09-17
priority: p1
effort: l
area: map
---

## Problem

The network is 578 segments across 29 routes and 496 stations, and it changes
when the MTA publishes a new feed version — which is to say, rarely, and never
mid-session. It is being handed to MapLibre as GeoJSON and re-tiled as though it
were live data.

Baked once into a vertex buffer with the tangent and band coefficients per
vertex, it becomes what it actually is: static geometry that the camera moves
over.

## Acceptance criteria

- [ ] One interleaved vertex buffer built once from `index.strokes()`
- [ ] Per-vertex tangent, `cb`, `mb`, route colour and weave level
- [ ] Built off the main thread, or fast enough that it does not matter — measured
- [ ] Rebuilt only when the network's `feedVersion` changes
- [ ] Memory footprint recorded, for comparison against the GeoJSON sources it replaces
