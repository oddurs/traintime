---
id: 19
uid: 53c33e4c-91e0-43fb-b1e6-482790f4a943
title: The drawn fan strays four pixels from the real one at the reveal
type: bug
status: done
milestone: render-3
created: 2026-09-18
updated: 2026-09-18
priority: p0
effort: m
area: map
---

## What happens

`bandOffsetExpression` samples `fanAt` at fifteen hand-written zooms and lets
MapLibre draw straight lines between them. The samples were placed for the
reveal and left one per zoom level everywhere else, and a chord across a steep
stretch of a smoothstep is nowhere near the curve.

Measured over the range the map can reach (`minZoom` 9.5, `maxZoom` 17), for the
A's four-track corridor spanning bands -3.469 to +3.469:

                          worst corridor width       worst single band
  15 hand-picked stops      4.16 px at zoom 13.50       2.08 px
  41 adaptive stops         0.17 px at zoom 15.43       0.10 px

Zoom 13.50 is the worst possible place for it: 13.4 to 14.2 is the reveal, where
a trunk stops being one line per colour and becomes one line per service. The
chord from the 13.4 sample to the 13.6 sample overshoots by four pixels, so the
corridor springs open early and settles back as you scroll through the split.
Through 15.4 to 16.6 it runs half a pixel to one and a half narrow.

Since render-2 the trains do not go through this list at all — they carry their
band into the shader and are offset by `fanAt` itself. So every pixel between the
samples and the curve is also a train sitting that far off its own line: 2.08 px
for the worst band, five times the camera staleness render-2 was built to remove,
present at rest rather than only during a gesture.

## Acceptance criteria

- [x] Stops chosen against the curve rather than written by hand
- [x] The places the curve is not smooth are pinned rather than straddled
- [x] Worst error under a tenth of a pixel per band, across the reachable range
- [x] A test holds the tolerance, and another holds the band bounds to the real network

## Fixed by choosing the stops against the curve

`buildFanStops()` pins the three places the curve is not smooth — the reveal
opening at 13.4, closing at 14.2, and the geometry taking over at
z = log2(156543.03 * cos(40.73) * TARGET_PX / TRACK_M) = 18.114 — and bisects
each gap until linear interpolation is inside a tenth of a pixel for the largest
bands the network contains.

Forty-one stops, worst 0.098 px per band, 0.17 px across a whole corridor.

The bounds are the part that can rot: they are FAN_BOUND = { cb: 2, mb: 4 },
comfortably past the network's real maxima of 1.484 and 3.469, and a corridor
gaining tracks would widen the bands past them and quietly push the error back
up. `tests/network.test.ts` holds both — one test on the tolerance, one checking
the real strokes still fit inside the bounds the stops were chosen for.

Worth recording that the first version of this measurement was wrong in the
user's favour and had to be redone: the error peaks at 5.13 px at zoom 18.11,
which is past the map's `maxZoom` of 17 and therefore unreachable. Re-measured
over 9.5 to 17 the peak is 4.16 px at 13.50 — smaller in magnitude, worse in
practice, because 13.5 is a zoom people actually use and it is the exact moment
a trunk splits into its services.
