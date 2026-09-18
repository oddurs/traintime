---
id: 7
title: Record frame timings for pan and pinch, before any of this changes
type: chore
status: backlog
milestone: render-1
created: 2026-09-17
updated: 2026-09-17
priority: p0
effort: s
area: map
---

## Problem

Three milestones of render work are about to be judged on whether the map "feels"
better. That is not a measurement, and this project already has the habit of
measuring instead — the storage numbers in `docs/STORAGE.md` are why the
retention windows are defensible.

Without a baseline taken now, every claim afterwards is an opinion.

## Acceptance criteria

- [ ] A repeatable procedure, not a one-off reading — scripted where possible
- [ ] Frame time and dropped-frame count for: idle, pan, pinch
- [ ] Each of those at city zoom (~11) and street zoom (~16)
- [ ] Numbers committed to `docs/` so the next milestone can be compared against them
- [ ] Taken on a throttled profile as well as an unthrottled one
