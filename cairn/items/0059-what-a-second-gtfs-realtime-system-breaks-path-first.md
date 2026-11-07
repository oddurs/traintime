---
id: 59
uid: 69fc02ac-cacb-4560-bcd2-2f8957a2d2a8
title: 'What a second GTFS-realtime system breaks: PATH first'
type: spike
status: backlog
milestone: reach
created: 2026-11-07
updated: 2026-11-07
priority: p3
effort: m
area: tracker
---

## Question

How much of bound is New York subway, and how much is a GTFS-realtime engine with a New York
skin? PATH is the nearest test: a different operator, a published realtime feed, riders who
change to the subway.

## Leading hypothesis

The tracker, kinematics and learner are general. These are New York-specific:

- the NYCT protobuf extensions (services/poller/proto/nyct-subway.proto);
- station complexes;
- the trunk table (src/lib/trunks.ts);
- the band layout's assumptions about shared track.

The colour system already generalises: ramps are measured from an agency's printed colours
(src/lib/ramps.ts).

## How to answer it

- Load PATH's static GTFS through scripts/build-network.ts behind a flag.
- Run its realtime feed through the tracker for an hour.
- List every failure and every place a New York assumption is hard-coded.
- Estimate the work for PATH, then for one more city (Chicago CTA or Boston MBTA).

## Acceptance criteria

- [ ] the Answer section below says what was found, with the evidence
- [ ] the items the answer calls for exist and depend on this one

## Answer
