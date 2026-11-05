---
id: 16
uid: 88d9c3f9-9eb1-4697-837e-a702632fa12b
title: Make (segment, s) the wire format for a train position
type: feature
status: done
milestone: render-4
assignee: claude
created: 2026-09-17
updated: 2026-09-18
priority: p2
effort: l
area: map
---

## Problem

`Kinematics` produces a longitude and latitude, and everything downstream treats
those as the truth. That is what makes a train's position independent of its
line, and therefore capable of disagreeing with it.

If the tracker instead reports progress — which segment, how far along, which
band — then the position is a question only the renderer can answer, against the
geometry it is drawing. The failure mode is not made less likely; it stops being
expressible.

This touches the tracker and the replay format, so it is deliberately last.

## Acceptance criteria

- [x] `TrainPosition` carries `(segment, s, band)` as its position
- [x] `lon`/`lat` remain available, derived, for the panel, search and `/state` consumers
- [x] Replay and the recorded tick format still round-trip
- [x] The invariant audit in `scripts/audit.ts` still passes against live data

## The position record is complete now

`TrainPosition` carries `segment` and `band` alongside `s`, which together are
the position; `lon`/`lat` stay on the record, derived, because the panel, the
search, the hit test and `/state` all want a coordinate.

The band moved out of the render loop and into the engine. It was being looked
up per train per frame against a map of the last band each train rode — state
about trains, kept beside the map rather than beside the trains — and the
fallback for a train with no stretch to read from now lives where the train's
history already is, on its `Body`, inherited across a body replacement the same
way the drawn heading is.

Verified before and after: the replay audit reports the same two pre-existing
failures (58 "arrival predicted absurdly far ahead", 27 "moving between one stop
and itself") with the change in and with it out, so it round-trips. The live
invariant audit passes, 0 high and 0 medium.

Worth recording what the measurement found while checking this item's premise,
because it is not what the milestone assumed. A train's position *along* its
line is not approximate and never was: the drawn geometry and the ridden path
are the same points to 0.0000 m across 444 segments, with none skipped, because
`laid()` is genuinely the single source. And no stop pair of a route is ridden
on two different bands by two different runs — 0 of 1067. So the two ways a
train could have had a position independent of its line are both already closed.

What is not closed is 0020.
