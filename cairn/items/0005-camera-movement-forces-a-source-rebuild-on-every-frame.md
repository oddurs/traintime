---
id: 5
title: Camera movement forces a source rebuild on every frame
type: bug
status: backlog
milestone: render-1
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

- [ ] `isMoving()` no longer appears in the `geoDue` gate
- [ ] Ribbons rebuild on the `drawInterval` clock only, moving or still
- [ ] A pinch gesture performs no more source uploads than the same period at rest
