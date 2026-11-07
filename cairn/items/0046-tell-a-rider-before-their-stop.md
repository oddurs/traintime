---
id: 46
uid: f68e173a-e6fb-4694-b088-f48f3f7f5881
title: Tell a rider before their stop
type: feature
status: backlog
milestone: ride
depends_on:
- 45
created: 2026-11-07
updated: 2026-11-07
priority: p0
effort: m
area: platform
---

## Problem

The reason to set a destination while riding is not to miss it. Nothing tells the rider it is
coming.

## Proposal

- While following a train with a destination, when its predicted arrival at the destination is
  under 90 seconds away, alert once:
  - vibrate where `navigator.vibrate` exists (Android);
  - show a system notification where permission was given (an installed iOS app or Android);
  - in all cases, a banner in the card: "Lorimer St next — about 1 min".
- Ask for notification permission when a destination is first set while following, never before.

## Acceptance criteria

- [ ] with a destination set on a followed train, one alert fires between 90 and 30 seconds before arrival and never twice for the same stop, checked by replaying a recorded trip
- [ ] with notifications denied, the in-card banner still appears
- [ ] the alert's timing is computed by a pure function covered by tests
