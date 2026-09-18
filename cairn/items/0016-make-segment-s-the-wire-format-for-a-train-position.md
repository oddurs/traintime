---
id: 16
title: Make (segment, s) the wire format for a train position
type: feature
status: backlog
milestone: render-4
created: 2026-09-17
updated: 2026-09-17
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

- [ ] `TrainPosition` carries `(segment, s, band)` as its position
- [ ] `lon`/`lat` remain available, derived, for the panel, search and `/state` consumers
- [ ] Replay and the recorded tick format still round-trip
- [ ] The invariant audit in `scripts/audit.ts` still passes against live data
