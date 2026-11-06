---
id: 25
uid: 469f69cf-addd-4bbd-8ba6-166463693b28
title: 'Trips that go backwards: the feed briefly republishes an older position'
type: bug
status: done
assignee: Oddur Sigurdsson
created: 2026-11-05
updated: 2026-11-05
closed_at: 2026-11-05
priority: p2
area: tracker
effort: m
---

## What happens

Replaying 9.5 hours of recorded ticks (5 November, 11:09 to 20:40), 163 trips went backwards: they
left a stop, then reached it again later. For example, `068750_B..N66R` left Brighton Beach for
Sheepshead Bay at 16:28, and was reported arriving at Brighton Beach again at 16:33.

- 162 of the 163 kept the same MTA train id, so this is not one trip id passing between two trains.
- 113 of them disappeared from the feed for more than 2 minutes first, then reappeared at an
  earlier stop.

The tracker expires a trip that is missing for 2 minutes and starts it fresh when it reappears.
A shorter gap leaves the trip in memory and it jumps back.

## What should happen

A trip the feed republishes at an earlier stop should not be drawn jumping back along the line, and
it should not be scored against its earlier pass. Possible approaches: treat a backwards jump as a
new run (fresh memory and a new marker), or hold it until the feed's position passes where it
already was. Decide from what the replay shows, not by taste.

## Reproduction

1. `npm run audit:status`, against a data directory with recorded ticks. The first line counts the
   trips that went backwards.
2. `npm run audit:status -- --trace 068750_B..N66R` shows one trip's snapshots and events.

## Acceptance criteria

- [x] The replay audit reports how many backwards trips are drawn moving backwards on the map
- [x] Whatever the tracker does with them is measured with `scripts/evaluate.ts` against this baseline: 189 m median short of platform, 507 still on an earlier segment

## 2026-11-05

Found: not a republish after a gap. The median gap at the jump was 31 s (one snapshot). gtfs-bdfm briefly reports a trip at a stop it has already left — sometimes on an older vehicle timestamp (stale record), sometimes newer (D at D03S reported at D01S for two ticks) — then carries on. Some are the reverse: a one-tick forward glitch, after which the feed rightly reports the train back where it was (a B held at D21N for 7 min, reported at D20N for one tick at 17:14). Fix: the tracker remembers the platforms a trip has left and ignores reports placing it back at one; it accepts them after 3 newer heartbeats over 45 s at that stop, or 5 min of newer reports. Never on an older timestamp. Replay (9.5 h): 237 trips' glitches ignored, 134 corrections accepted, 0 unexplained backwards trips (from 163). evaluate.ts, 2 h of evening peak: still on an earlier segment at real arrival 507 -> 465, p90 short of platform 492 -> 489 m, median 189 m unchanged, ETA errors unchanged. Not handled: 61 trips back after >2 min (expired) behind where last seen — the tracker treats them as new runs; shuttles reuse ids this way, so remembering expired trips would block real runs.
