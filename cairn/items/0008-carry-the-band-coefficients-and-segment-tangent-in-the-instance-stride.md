---
id: 8
title: Carry the band coefficients and segment tangent in the instance stride
type: feature
status: backlog
milestone: render-2
created: 2026-09-17
updated: 2026-09-17
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

- [ ] `cb`, `mb` and the segment tangent are written into the instance buffer
- [ ] `STRIDE` is adjusted and the comment explaining the byte count still holds
- [ ] `writeMark()` takes them positionally, allocating nothing per train
- [ ] No trigonometry per train per frame remains in the frame loop
