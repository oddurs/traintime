---
id: 25
uid: 469f69cf-addd-4bbd-8ba6-166463693b28
title: 'Trips that go backwards: the feed republishes a trip at an earlier stop after a gap'
type: bug
status: backlog
created: 2026-11-05
updated: 2026-11-05
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

- [ ] The replay audit reports how many backwards trips are drawn moving backwards on the map
- [ ] Whatever the tracker does with them is measured with `scripts/evaluate.ts` against this baseline: 189 m median short of platform, 507 still on an earlier segment
