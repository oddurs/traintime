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
updated: 2026-09-17
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
- [ ] A train is provably on its stroke — sampled at several zooms, mid-gesture
