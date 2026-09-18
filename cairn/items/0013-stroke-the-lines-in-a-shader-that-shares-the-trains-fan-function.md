---
id: 13
title: Stroke the lines in a shader that shares the trains' fan function
type: feature
status: backlog
milestone: render-3
depends_on:
- 9
- 11
- 12
created: 2026-09-17
updated: 2026-09-18
priority: p1
effort: xl
area: map
---

## Problem

This is the change that makes the sync structural rather than maintained. One
shader strokes the line and offsets it by `cb * fan.colour + mb * fan.metric`,
from the same uniform the train layer reads in the same pass. The offset is
applied to geometry that knows its own tangent, so joins are solved for the line
being drawn rather than for the centreline it came from.

Expanding the stroke in the vertex stage also means width is a pixel quantity
computed with the frame's matrix, which is what removes the shimmer: there are no
zoom stops to interpolate between.

## Acceptance criteria

- [ ] Lines, casings and the weave order drawn in one pass with the trains
- [ ] One fan function, called from both the line and the train shader
- [ ] Joins and caps correct on the tightest curves in the network
- [ ] Route filtering still works, without touching the vertex buffer
- [ ] Frame timings beaten against the render-1 baseline, at both zooms

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
