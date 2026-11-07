---
id: 48
uid: 8a675f64-d51b-4cf2-b515-bf597b697f33
title: Keep a followed train moving without a connection
type: spike
status: backlog
milestone: ride
created: 2026-11-07
updated: 2026-11-07
priority: p1
effort: m
area: tracker
---

## Question

When the stream drops mid-ride, can the client keep moving the followed train along its route
from what it already has, and how wrong does it get, and how fast?

## Leading hypothesis

The client already holds the learned run times and dwells (public/data/timing.json, which the
in-browser tracker uses) and the train's remaining stops with their predicted times. Advancing
the train along those, with the learned run time per segment, stays within about 60 seconds of
where it really is for 5 minutes. Past that the position should be shown as a range rather than
a point, and past 15 minutes it should stop.

## How to answer it

- Replay recorded trips.
- At each moment, cut the feed, dead-reckon forward from the last state, and compare with where
  the train actually arrived at each stop.
- Plot error against time since the last update.
- Note which lines and times of day are worst.

## Acceptance criteria

- [ ] the Answer section below says what was found, with the evidence
- [ ] the items the answer calls for exist and depend on this one

## Answer
