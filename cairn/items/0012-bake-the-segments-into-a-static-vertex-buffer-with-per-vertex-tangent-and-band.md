---
id: 12
title: Bake the segments into a static vertex buffer with per-vertex tangent and band
type: feature
status: done
milestone: render-3
assignee: claude
created: 2026-09-17
updated: 2026-09-18
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

- [x] One interleaved vertex buffer built once from `index.strokes()`
- [x] Per-vertex tangent, `cb`, `mb`, route colour and weave level
- [x] Built off the main thread, or fast enough that it does not matter — measured
- [x] Rebuilt only when the network's `feedVersion` changes
- [x] Memory footprint recorded, for comparison against the GeoJSON sources it replaces

## Re-justified: the widths were not this

The evidence this item was filed on did not survive being measured, so the case
for it has changed rather than the item.

The widths were never shimmering because of the geometry. The casing margin is
monotonic and smooth and uses the same stops for line and casing (0015, dropped),
and the real four-pixel error was in how the offset curve was sampled, fixed in
0019 by choosing the stops against the curve instead of by hand.

The joins were inspected at the tightest thing in the network — the A/C's
ninety-degree turn at Broadway Junction, at zoom 14.3, where an eleven-pixel
offset is comparable to the curve radius in pixels. The parallel bands hold their
spacing through the bend with no pinching and no crossing. Whatever `line-offset`
does to a tessellation solved for the centreline, it is not visible here.

What still argues for this work, and it is worth doing on these grounds rather
than the old ones:

  - 0017 needs a line vertex buffer to resolve arc-length against, and that is
    the strongest invariant left in the plan.
  - The selection ring and the platform counts are still positioned by longitude
    and latitude, which means `fanOffsetPx` is still a second copy of the fan sum
    living on the CPU. Drawing them as instanced marks retires it.

Neither is urgent, and neither is what the original complaint was about.

## Baked

`lineGeometry.ts`. 2 950 strokes, sorted by weave level so each level's triangles
are one contiguous range, into an interleaved Float32Array: prev, pos, next,
side, cap, band, colour. Route index rides in a parallel Uint8Array as an
integer attribute so the shader can shift and mask it for filtering.

  52 546 vertices   139 938 indices   3.06 MB   24 ms, once

prev and next are carried per vertex because the extrusion happens in screen
space — that is where a pixel is defined — and the shader can only work out the
screen direction of a bend by projecting all three. An end marks itself by
repeating its own position.

Under 65 536 vertices, so sixteen-bit indices, which halves the index buffer.
That was not a given: the cap pairs added 11 800 vertices and took it from
40 746 to 52 546. A third of the headroom is gone and a denser network would
cross it, at which point the indices become Uint32 and the buffer grows by
280 KB.

Built on the main thread at load. 24 ms against a map that takes seconds to
appear is not worth a worker, and the criterion allowed either as long as it was
measured.
