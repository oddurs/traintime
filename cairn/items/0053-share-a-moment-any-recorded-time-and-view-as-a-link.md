---
id: 53
uid: 50c37d4f-7a2b-4922-8765-935c9e50a56d
title: 'Share a moment: any recorded time and view as a link'
type: feature
status: backlog
milestone: record
created: 2026-11-07
updated: 2026-11-07
priority: p1
effort: m
area: front-end
---

## Problem

Replay exists (`#replay=from,to,speed` in src/lib/urlState.ts, and the Timeline in the Lines
group), but making a link to "what happened at 8:15 on Tuesday on the F" means building a URL by
hand.

## Proposal

- A Share control in replay, and on a train's or station's view while in replay, makes a link
  holding the moment, the camera and the selection. It uses `navigator.share` where it exists,
  and otherwise copies the link and says "Link copied".
- Opening the link starts replay paused at that moment, with that view and selection.

## Acceptance criteria

- [ ] a link made from replay opens at the same moment, camera and selection, paused, checked by audit-ui
- [ ] on a phone the system share sheet opens; on a desktop the link is copied and the card says so
