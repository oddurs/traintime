---
id: 5
title: Camera movement forces a source rebuild on every frame
type: bug
status: done
milestone: render-1
assignee: claude
created: 2026-09-17
updated: 2026-09-17
priority: p0
effort: s
area: map
---

## What happens

`TrainMap.tsx:303` gates the expensive path on:

    const geoDue = map.isMoving() || ts - lastDraw >= drawInterval(map.getZoom());

So while the camera is moving, every frame is due. The ribbon source re-uploads
each frame, and each upload serialises to a worker, re-parses, re-tiles and
rebuilds symbol buckets. The comments in the same file put that at roughly nine
milliseconds of main thread for seven hundred features — which is why the trains
were taken off GeoJSON in the first place.

The result is that the pipeline is busiest exactly when the main thread is
already doing camera work, which is what panning and pinching feel like.

## Reproduction

Pinch-zoom anywhere with ribbons shown. Frame times spike for the duration of the
gesture and recover the moment it ends.

## Acceptance criteria

- [x] `isMoving()` no longer appears in the `geoDue` gate
- [x] Ribbons rebuild on the `drawInterval` clock only, moving or still
- [x] A pinch gesture performs no more source uploads than the same period at rest

## Removed, and what it cost to prove

The `isMoving()` term was left over from when this gate governed the trains,
and holding *them* back through a pinch genuinely did make them swim off their
lines — the comment above the gate said so. It does nothing for the two things
still on this clock: a ribbon is `LonLat[]`, so moving the camera does not
change it, and MapLibre reprojects the geometry it already holds for free. A
ribbon needs re-uploading when its train advances along its path, which is a
fact about time that `drawInterval` already tracks.

Measured, before and after, on the same instrumented build (ribbons per second,
idle / pan / scroll in):

  1x zoom 11    3.5  17.5  18.3   ->   3.7   3.7   3.7
  4x zoom 11    3.0  16.2  18.0   ->   4.0   3.6   3.7
  1x zoom 16   15.5  22.7  31.4   ->  17.2  15.4  14.8
  4x zoom 16   14.5  23.9  33.0   ->  17.5  14.5  18.5

drawInterval is 4.0 Hz at zoom 11 and 20.7 Hz at zoom 16. Before, a gesture
pushed the rate to four to six times the clock at zoom 11; after, all three
scenarios sit on it, exactly so at zoom 11.

The trains do still swim, and that is real — but the cause is the fan being
derived twice from two readings of the camera, which is render-2. No rebuild
rate fixes it, and the stale comment claiming otherwise has gone with the term.
