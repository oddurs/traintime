---
id: 39
uid: bdb7d7ab-9e9e-4086-b8d3-539fe4a01d10
title: 'Leave-by: the next train you can catch, on the home view'
type: feature
status: backlog
milestone: commute
depends_on:
- 38
created: 2026-11-07
updated: 2026-11-07
priority: p0
effort: m
area: front-end
---

## Problem

The home view answers nothing until a station is opened. A commuter's question — when do I
have to leave for my train — needs the next arrivals, the walk to the platform and the margin of
error together, and bound already has all three:

- `arrivalsAt` in src/lib/arrivals.ts;
- `walkSeconds` in src/lib/places.ts;
- the calibrated σ on each arrival.

## Proposal

- A pure function in src/lib/commute.ts,
  `leaveBy(arrivals, walkS, now) → { train, leaveIn, next } | null`. It picks the first arrival
  whose `eta − 1σ` is at least `walkS` away, so the advice holds when the train runs early. It
  says how long until leaving (`eta − 1σ − walkS − now`) and names the train after it.
- The walk comes from the live location when it is on. Otherwise there is no walk time: the line
  shows the next train only ("Next 8:42 L, then 8:51"), and never invents a walk.
- A row at the top of the home card, above Nearby, for the station and direction `usualTrip`
  gives. For example: "Leave in 3 min for the 8:42 L to Canarsie · next 8:51". Tapping it opens
  the station's board.
- Under 1 minute the row reads "Leave now".
- When no train can be caught, it names the next train it can.

## Acceptance criteria

- [ ] `leaveBy` is covered by tests: it skips a train whose early edge is inside the walk, says "now" at under a minute, and returns null with no arrivals
- [ ] with a saved station and recorded uses the home card shows the row from first paint of live data, and it updates as the trains move
- [ ] with location off the row never states a walk or a leave time, only the next trains
- [ ] the row has an accessible name that reads as one sentence

## 2026-11-07

Margin: advise the first train whose early edge (eta − 1σ) clears the walk, not its centre. With calibrated σ about 16 % of trains arrive earlier than eta − 1σ, so advice on the centre would send about half of riders to a train that leaves as they arrive. 0040 measures whether 1σ is the right margin. With location off, the row shows only the next trains and never invents a walk.
