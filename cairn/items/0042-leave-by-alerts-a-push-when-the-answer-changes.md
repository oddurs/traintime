---
id: 42
uid: 3ef2e03b-c951-4bfb-9b52-1c2b26eeed85
title: 'Leave-by alerts: a push when the answer changes'
type: feature
status: backlog
milestone: commute
depends_on:
- 39
- 41
created: 2026-11-07
updated: 2026-11-07
priority: p2
effort: l
area: poller
---

## Problem

The leave-by row helps only when the app is open. The moment that matters is the one where the
answer changes while the phone is in a pocket.

## Proposal

The shape the spike settles. As planned before it:

- a "Notify me" control on the leave-by row asks for permission, on that tap only;
- the poller keeps subscriptions holding an endpoint, a station, a direction and a window;
- once a minute inside the window it evaluates `leaveBy`, and pushes only when the named train
  changes or its leave time moves by two minutes or more;
- unsubscribe is one tap, and deletes the record.

Refine this body from the spike's answer before starting.

## Acceptance criteria

- [ ] a held train inside a subscriber's window produces one push naming the replacement train, within two minutes, on an installed iPhone and an Android phone
- [ ] no push is sent when nothing changed, checked over a recorded day replayed through the evaluator
- [ ] a subscription record holds only endpoint, station, direction and window, and unsubscribing deletes it
