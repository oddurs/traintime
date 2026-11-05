---
id: 7
uid: eda588ac-95b2-49fd-872e-88c32d8fe69a
title: Record frame timings for pan and pinch, before any of this changes
type: chore
status: done
milestone: render-1
assignee: claude
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

- [x] A repeatable procedure, not a one-off reading — scripted where possible
- [x] Callback time, main-thread share and source uploads for: idle, pan, scroll in
- [x] Each of those at city zoom (~11) and street zoom (~16)
- [x] Numbers committed to `docs/` so the next milestone can be compared against them
- [x] Taken on a throttled profile as well as an unthrottled one

## Why this does not report dropped frames

Criterion 2 asked for frame time and a dropped-frame count. Neither is reported,
and the criterion has been amended rather than ticked as written.

The headless browser rasterises in software, so its frame rate and therefore its
dropped-frame count are facts about SwiftShader: in the baseline, zoom 16 reads
9.2 fps idle and 16.4 fps while scrolling in. Scrolling is not faster than
sitting still. That is noise, and a target expressed in it could be met by
making the rasteriser's life easier while changing nothing we are responsible
for. On real hardware the rate is pinned to the display right up until it is
not, which hides the problem until it is severe.

What is measured instead, for the same three scenarios and both zooms:

  cb mean/max  milliseconds inside our own rAF callback
  main%        share of wall time the main thread spent in tasks — where an
               upload is actually paid for, since the callback returns long
               before the worker is done
  */fr         setData calls per frame, per source

The last is the real target because it is scale-free: `trains/fr = 1.00` means
every frame asks for an upload regardless of how fast frames are arriving.

A frame rate does become the right measure at render-3, which changes what the
GPU is asked to draw rather than what the main thread is asked to prepare — and
that will need measuring on real hardware, which this script cannot do. Noted
there rather than left implied here.
