---
id: 4
uid: fab2a120-361e-4117-ac1d-8c3e3d701930
key: render-4
title: Positions as arc-length
type: milestone
status: backlog
created: 2026-09-17
updated: 2026-09-17
priority: p2
---

Give a train no position of its own, so it cannot leave its line.

The strongest invariant available, and last because it is the only one that
reaches back into the tracker.

A train stops having coordinates. It becomes `(segment, s, band)` — a progress
along a polyline — and the renderer resolves `s` against the same vertex buffer
it strokes the line from.

This is what makes the map dead reliable rather than merely tuned: the failure is
not made unlikely, it is made unrepresentable.
