---
id: 17
title: Resolve arc-length against the line vertex buffer on the GPU
type: feature
status: backlog
milestone: render-4
depends_on:
- 13
- 16
created: 2026-09-17
updated: 2026-09-18
priority: p2
effort: xl
area: map
---

## Problem

The last step: given `(segment, s)`, look the point and tangent up in the same
buffer the line is stroked from, in the vertex stage. A train is then drawn on
its line by construction, at any zoom, at any camera velocity, with no CPU work
per train at all beyond writing a progress value.

## Acceptance criteria

- [ ] Segment offsets and cumulative arc-length available to the shader
- [ ] Position and tangent interpolated from the line buffer, not passed in
- [ ] Per-train per-frame CPU work is a single float write
- [x] A train is provably on its stroke — sampled at several zooms, mid-gesture

## The premise, measured — and why this would add a derivation rather than remove one

Not built. The measurement says it would make the architecture worse by this
project's own principle, and it is worth writing down why before anyone spends
an XL on it.

What this item was filed to fix does not exist. A train's position along its
line is exact: the drawn geometry and the ridden path are the same points to
0.0000 m over 444 segments, none skipped, because `laid()` is the single source
for both. Resolving `s` on the GPU would reproduce a position the CPU already
computes exactly, from the same geometry.

And it cannot remove the CPU path. The hit test has to answer "which train is
under the pointer", and a pointer cannot query a vertex buffer; the selection
ring, follow mode and `/state` all want a coordinate too. So the CPU would go on
resolving positions and the GPU would resolve them again — two evaluations where
there is currently one, which is the shape render-2 existed to get rid of.

It would also cost accuracy or a lot of machinery. A resampled atlas — say 64
samples a segment — chords a 2 km stretch every 31 m, visibly worse than
`alongPath` on a curve. Keeping the exact polyline instead means a binary search
per vertex in the vertex stage, against a data texture, to save the ~0.5 ms the
whole frame callback currently costs for five hundred trains.

The one criterion here with standalone value is the fourth, and it has been
answered by measurement rather than by machinery — see 0016's note and 0020.

Leaving this open rather than dropping it, because the argument is about cost
and not about whether it is possible, and a future where the ring and the counts
are instanced marks and the hit test is the only CPU reader would change the
arithmetic.
