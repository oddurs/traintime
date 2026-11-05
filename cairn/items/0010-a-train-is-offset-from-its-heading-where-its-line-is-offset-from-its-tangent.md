---
id: 10
uid: d39dd3ba-736f-4dd3-a47e-9df3c73e3b05
title: A train is offset from its heading where its line is offset from its tangent
type: bug
status: done
milestone: render-2
depends_on:
- 8
created: 2026-09-17
updated: 2026-09-18
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

- [x] The lateral offset uses the segment tangent, not the train's bearing
- [x] The junction ramp is reproduced, so a train matches its line through a ramp too
- [x] A train on a curve sits on its stroke with the camera at rest, at every zoom

## Fixed, and the premise was right for the wrong reason

The offset now uses p.tangent — alongPath(path, s).bearing, the polyline
segment's own direction, which is the basis the geometry's normal is built
from. p.bearing keeps orienting the chevron.

The item said heading and tangent differ on curves and near junction ramps.
They do, but the mechanism is more specific than that: b.heading is
lerpBearing-smoothed toward headingAt(path, s), and b.shown is then
rate-limited on top of it by MAX_TURN_PER_S, explicitly so the arrow sweeps
through a curve instead of snapping round it. A damped direction is the right
thing to point an arrowhead with and the wrong thing to displace a position
by, and it lags hardest exactly where the curve is tightest.

Measured over 162 moving trains at zoom 14:

  |bearing - tangent|   mean 0.10 deg   p50 0.00   p95 0.87   max 2.07
  lateral equivalent    mean 0.03 px    p95 0.26   max 0.63
  trains off by >5 deg  0 of 162

So the rate limiter almost never binds: subway curves are gentle against
MAX_TURN_PER_S, and headingAt already smooths over a 26 m window. The error is
sub-pixel, like the camera one, and this was not what anybody was seeing
either.

Worth having done anyway, and not because of the pixels: the offset basis is
now the track's direction as a matter of definition, so it stays correct if
somebody retunes the damping for the arrowhead — which is a change nobody
would expect to move a train sideways.
