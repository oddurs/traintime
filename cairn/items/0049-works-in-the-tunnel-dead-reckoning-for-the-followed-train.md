---
id: 49
uid: 5e8150a2-943d-4f85-909d-86def5a58f13
title: 'Works in the tunnel: dead reckoning for the followed train'
type: feature
status: backlog
milestone: ride
depends_on:
- 45
- 48
created: 2026-11-07
updated: 2026-11-07
priority: p1
effort: l
area: tracker
---

## Problem

A rider loses signal between stations most of the way through Manhattan. The riding view
freezes, or worse, shows a confident position from minutes ago.

## Proposal

The spike sets the limits. As planned before it:

- when the stream is down while following, the client advances the followed train with learned
  run times;
- the view says so: "No signal since 8:41 · estimated", with a widening range;
- the estimate stops at the limit the spike found;
- on reconnect it snaps back to live data.

Refine this body from the spike's answer before starting.

## Acceptance criteria

- [ ] with the connection cut during a replayed trip, the followed train keeps moving and is labelled as estimated, with the time of the last update
- [ ] the estimate's error over the first 5 minutes is within the figure the spike recorded, measured by a script over recorded trips
- [ ] past the spike's limit the view stops estimating and says so
