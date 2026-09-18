---
id: 10
title: A train is offset from its heading where its line is offset from its tangent
type: bug
status: backlog
milestone: render-2
depends_on:
- 8
created: 2026-09-17
updated: 2026-09-17
priority: p0
effort: m
area: map
---

## What happens

`fanned()` (TrainMap.tsx:44) pushes a train perpendicular to `p.bearing` — where
the train is pointing. The geometry is pushed perpendicular to the line's local
tangent, and ramped over 130 m near junctions by `offsetPolylineRamped`
(layout.ts:271, `RAMP_M` at :50).

On a curve or an approach ramp those two normals are not the same vector, so the
train sits beside its own line — systematically, and worst at curves and
junctions, which is where the eye goes. Unlike the camera race this one is wrong
even at rest, so no update frequency has ever hidden it.

## Reproduction

Watch any train through a tight curve with the map completely still. It rides
outside its stroke through the bend and returns to it on the straight.

## Acceptance criteria

- [ ] The lateral offset uses the segment tangent, not the train's bearing
- [ ] The junction ramp is reproduced, so a train matches its line through a ramp too
- [ ] A train on a curve sits on its stroke with the camera at rest, at every zoom
