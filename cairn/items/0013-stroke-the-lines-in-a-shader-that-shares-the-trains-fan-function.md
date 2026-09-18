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
updated: 2026-09-17
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
