---
id: 6
uid: b815d05b-bee5-4d4c-a128-c1ff95f47515
title: The ring source uploads every frame whether or not it changed
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

`TrainMap.tsx:444` calls `setData` on the `trains` source unconditionally, once
per frame, outside the `geoDue` gate. The comment justifies it as "one or two
features, so this stays cheap at the frame rate" — and the feature count is
indeed small, but the cost being paid is not the feature count. It is a worker
round-trip, a re-tile and a source invalidation, sixty times a second, for
geometry that changes only when the selection does.

## Reproduction

Select nothing and sit still. The source is still re-uploaded every frame.

## Acceptance criteria

- [x] The ring source is handed new data only when its contents differ
- [x] A frame in which no ring moved performs no source upload
- [x] The selection ring still tracks its train without visible lag

## Conditional now, and how the ring is guarded

The signature is accumulated as the rings are pushed, so nothing is walked
twice, and it is quantised to six decimals — about a tenth of a metre, finer
than a pixel at any zoom this map reaches. A train that is genuinely moving
still registers every frame; one standing at a platform does not.

trains/fr went 1.00 -> 0.00 in all twelve measured scenarios, because nothing
is selected most of the time and the signature is then the empty string.

With a train selected the ring does move and an upload is work that has to
happen. `scripts/audit-ring.mjs` (npm run audit:ring) asserts the invariant in
both directions: following a train at 27 m/s it measured 138 uploads over 164
frames, skipping the 16% of frames where the train had slowed below a tenth of
a metre per frame. Standing at a platform it measured 0 over 346.

Two mistakes in the first version of that check, worth knowing about because
both produce a convincing false result:

  - `source._data` is wrapped as `{ geojson: … }` in this MapLibre, so reading
    `_data.features` gives undefined and reports an empty ring that is in fact
    present and correct.
  - Navigating from `?perf=1` to `?perf=1#t=<id>` differs only in the fragment,
    so it is a same-document navigation: the app never remounts, readHash()
    never runs, and the train is never selected. The check then reports a
    missing ring the app was never asked to draw.

Making the ring instanced geometry in the train layer would remove the upload
even in the selected case. That is render-3, not here.
