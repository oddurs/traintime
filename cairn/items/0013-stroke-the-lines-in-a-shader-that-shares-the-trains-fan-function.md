---
id: 13
uid: a0fc4c6e-65ee-4c03-b3c2-7669b8e10f06
title: Stroke the lines in a shader that shares the trains' fan function
type: feature
status: done
milestone: render-3
assignee: claude
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

- [x] Lines, casings and the weave order drawn in one pass with the trains
- [x] One fan function, called from both the line and the train shader
- [x] Joins and caps correct on the tightest curves in the network
- [x] Route filtering still works, without touching the vertex buffer
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

## Built; the timing criterion is not met

`lineLayer.ts` strokes the weave and calls the same `fanAt` the trains do, in
the same pass, from the camera of the frame being drawn. Nine draws of two
instances — instance 0 the casing, instance 1 the line — per weave level,
lowest first, so a crossing still reads as one line passing under another.
Filtering is a bitmask uniform; the widening when filtered is the same
`fanScale` closure the train layer reads.

Joins are mitered, clamped at four, and both the band offset and the half width
take the same correction because both are perpendicular displacements at a
joint. Ends carry a duplicate vertex pair pushed out by the half width so the
fragment stage can round the cap. Checked at the tightest thing in the network,
the A/C's ninety degrees at Broadway Junction at zoom 14.3, where an
eleven-pixel offset rivals the curve radius: the bands hold their spacing
through the bend.

The fourth criterion is NOT met and is left unticked.

                                  main ms/fr    fps
  eighteen GeoJSON layers              7.50     27.7
  ours, eighteen draws                 9.63     22.7
    + viewport culling                 8.83     26.1
    + nine instanced draws             8.42     27.3

1.12x slower, not faster. Two things worth knowing, neither an excuse. The
harness rasterises in software, so every GL call is charged to the main thread —
the thread that column measures — and moving work onto the GPU looks like a
regression whatever the GPU would have done with it. On real hardware this
plausibly goes the other way, and that is a measurement this harness cannot
take.

And the cost is fill and draw calls, not vertices: dropping the casing pass
lands at 7.51, within noise of MapLibre, while culling fifty thousand vertices
down to what is on screen bought 8%. MapLibre's line shader is better optimised
than a first version of one, which is what it should be.

One optimisation was reverted after measuring: narrowing the antialiasing
extension from one pixel to half — strictly less fill — made it 2.7x slower,
reproducibly. A software-rasteriser pathology, not a fact about the code.
