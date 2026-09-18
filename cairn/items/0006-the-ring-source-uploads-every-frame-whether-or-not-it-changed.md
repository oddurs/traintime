---
id: 6
title: The ring source uploads every frame whether or not it changed
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

`TrainMap.tsx:444` calls `setData` on the `trains` source unconditionally, once
per frame, outside the `geoDue` gate. The comment justifies it as "one or two
features, so this stays cheap at the frame rate" — and the feature count is
indeed small, but the cost being paid is not the feature count. It is a worker
round-trip, a re-tile and a source invalidation, sixty times a second, for
geometry that changes only when the selection does.

## Reproduction

Select nothing and sit still. The source is still re-uploaded every frame.

## Acceptance criteria

- [ ] The ring source is handed new data only when its contents differ
- [ ] A frame in which no ring moved performs no source upload
- [ ] The selection ring still tracks its train without visible lag
