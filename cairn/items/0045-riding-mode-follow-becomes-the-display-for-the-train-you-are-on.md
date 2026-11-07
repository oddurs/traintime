---
id: 45
uid: 8a6fc634-8eb0-47bf-a807-39612d30655c
title: 'Riding mode: Follow becomes the display for the train you are on'
type: feature
status: backlog
milestone: ride
created: 2026-11-07
updated: 2026-11-07
priority: p0
effort: m
area: front-end
---

## Problem

Following a train keeps the screen awake and the map centred (useWakeLock, src/lib/geolocation.ts),
but the card still shows the watching view. A rider holding the phone on a train wants what an
in-car display shows: the next stop, large, the changes there, and how many stops to theirs.

## Proposal

While following, the train view switches to a riding layout:

- the next stop in the title role, with its countdown;
- the lines to change to there;
- when a destination is set, "4 stops · 9 min to Lorimer St" and the progress along the whole
  trip;
- the rest of the view one tap away.

Leaving Follow returns to the normal train view. On a phone the card opens to half while riding.

## Acceptance criteria

- [ ] following a train with a destination shows the next stop, its countdown, the changes and the stops and minutes left to the destination
- [ ] following without a destination shows the same, without the destination line
- [ ] stopping Follow returns the train view as it was, and Back still closes it
