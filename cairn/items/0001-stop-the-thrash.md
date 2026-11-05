---
id: 1
uid: b36a5ab2-33a9-4c90-8db7-258cd7dd200f
key: render-1
title: Stop the thrash
type: milestone
status: done
created: 2026-09-17
updated: 2026-09-17
priority: p2
---

Stop paying the GeoJSON pipeline for camera movement.

The cheapest of the four, and the one that addresses what you actually feel while
panning. No architecture: two changes to what the frame loop is allowed to touch,
plus a measurement so the three milestones after this can be judged rather than
believed.

The trains were moved off GeoJSON precisely because a source update serialises to
a worker, re-parses, re-tiles and rebuilds symbol buckets — about nine
milliseconds of main thread. That reasoning is written in the comments. The gate
then turns the whole pipeline back on whenever the camera is moving, which is the
one moment the main thread is already busiest.
