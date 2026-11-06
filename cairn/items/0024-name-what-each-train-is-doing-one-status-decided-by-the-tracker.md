---
id: 24
uid: a113980f-272e-46da-bc43-c41729e7927f
title: 'Name what each train is doing: one status, decided by the tracker'
type: feature
status: doing
created: 2026-11-05
updated: 2026-11-05
priority: p1
area: tracker, map
effort: m
---

## Problem

A train's state was spread over five signals: the phase, `assigned`, a `stale` flag, the motion
model's `holding`, and a stall clock each browser started from zero on page load. Nothing named
their combinations, so:

- 197 of 467 "moving" trains had never been seen to leave anywhere. 177 of them were reported by
  the feed as `IN_TRANSIT_TO` the first stop of a trip whose scheduled start was still ahead: trains
  making ready for a trip. They were drawn on the track short of their terminal, sat still, and were
  ringed as stopped.
- "Stopped for N min" counted from page load. A train held for 20 minutes read as moving for the
  first two minutes of a visit.

## Proposal

One `status` per train, decided by the tracker: scheduled, preparing, at-platform, running, held,
lost (see `TrainStatus` in `src/lib/types.ts`). The phase stays as the motion model's input. A
preparing train is parked at its first stop.

## Acceptance criteria

- [x] Every train the tracker emits has exactly one status, with a rule and a test for each
- [x] A preparing train is parked at its first stop, not drawn mid-track
- [x] `held` is computed by the server from the departure time, so it is right from page load
- [x] The map, legend, station board and train detail all read the status; the browser's stall clock is gone
- [ ] The poller is deployed before the site, which reads `status`

## 2026-11-05

Accuracy, replaying 9.5 h of recorded ticks (scripts/audit-status.ts): preparing 92.9% left within ±2 min of start (median 0.0 min); held between stations 90.2% precision / 93.4% recall; held at a platform 97.6% on numbered lines, 62.5% on lettered (n=24); lost 7.0% came back (was 45.5%); 23 flaps in 9.5 h (was 227). Rejected: keeping heartbeat trains at the platform while beating past the modelled departure — evaluate.ts went from 189 m to 476 m median short of platform; reverted, noted in tracker.ts.
