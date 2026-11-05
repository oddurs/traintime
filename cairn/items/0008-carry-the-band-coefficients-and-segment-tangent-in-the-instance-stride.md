---
id: 8
uid: 506243f5-5417-4528-80c9-3ce9b16c6780
title: Carry the band coefficients and segment tangent in the instance stride
type: feature
status: done
milestone: render-2
assignee: claude
created: 2026-09-17
updated: 2026-09-18
priority: p0
effort: m
area: map
---

## Problem

Each train's band is two small numbers from `index.lateralBand()` — `cb` and
`mb`. Today they are converted into metres per train per frame on the main
thread, which is both the cost and the desync. They are properties of the train's
place in the network, and they change only when it moves between segments.

The lateral direction has the same shape: the line is offset perpendicular to its
own local tangent, so the tangent belongs in the buffer beside the band rather
than being re-derived from the train's heading.

## Acceptance criteria

- [x] `cb`, `mb` and the segment tangent are written into the instance buffer
- [x] `STRIDE` is adjusted and the comment explaining the byte count still holds
- [x] `writeMark()` takes them positionally, allocating nothing per train
- [x] No trigonometry per train per frame remains in the frame loop

## In the stride, and what it cost

STRIDE went 16 -> 20 floats, 64 -> 80 bytes a train: a_tangent at float 15 and
a_band (cb, mb) at 16, so the vec2 lands on an eight-byte boundary. Two slots
spare at 18 and 19 for the arc-length render-4 wants.

The tangent is new on TrainPosition rather than reused from `bearing`, because
they are different quantities and only one of them may be damped — see 0010.
It costs nothing to produce: `emit()` already calls `alongPath(b.path, b.s)`
for the position, and the segment bearing falls out of the same call.

Both marks of a train — the bullet and the chevron — carry the same band and
tangent, since the fan displaces the train and not the glyph.
