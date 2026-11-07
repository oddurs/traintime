---
id: 38
uid: 467d51be-b92f-453a-b73b-e21f0943072d
title: Remember which way a rider goes from each station, by time of day
type: feature
status: backlog
milestone: commute
created: 2026-11-07
updated: 2026-11-07
priority: p0
effort: m
area: front-end
---

## Problem

Leave-by needs to know where a rider is going from, and which way. `SavedPlace` has a
`direction` field (src/lib/places.ts) and `touch(id, direction)` accepts one, but nothing ever
passes it: every call is `touch(id)`. And one direction per station is wrong for a commuter, who
goes south at 8 am and north at 6 pm.

## Proposal

- Record a use each time a rider shows which way they are going from a station:
  - opening a train from a board's direction group;
  - setting a destination from that station.
- Store, per saved station, a count per (direction, weekday or weekend, hour of day) in
  localStorage, alongside `tt.places.v1`.
- A pure function in src/lib/commute.ts,
  `usualTrip(places, uses, now) → { station, direction } | null`, returns:
  - the saved station and direction most used within ±1 hour of now, on the same kind of day;
  - otherwise the most recently used saved station, with no direction;
  - otherwise null.
- No location is needed.

## Acceptance criteria

- [ ] opening a train from a station's northbound group records one northbound use for that station and hour; setting a destination records one too
- [ ] `usualTrip` is covered by tests: a weekday 8 am pattern and a weekday 6 pm pattern on the same station each win in their own hour, a weekend does not borrow from weekdays, and no uses returns the most recent saved station with no direction
- [ ] the uses survive a reload, and clearing site data leaves the app working with no leave-by line
