---
id: 37
uid: 369085a4-c64a-4c0b-9c7d-f2ecd0ec4e71
title: Make bound installable, and say why it is worth it
type: feature
status: backlog
milestone: commute
created: 2026-11-07
updated: 2026-11-07
priority: p1
effort: s
area: platform
---

## Problem

A push notification on an iPhone is only possible for a web app added to the home screen
(iOS 16.4 and later). The manifest exists (src/app/manifest.ts) and the service worker is
registered, but nothing tells a rider that installing changes anything, and nothing checks the
app actually qualifies as installable.

## Proposal

- Confirm the manifest has what Chrome and Safari require: name, icons at 192 and 512, start_url,
  display standalone, theme colour.
- When a rider saves their first station, offer installing once, in a Notice in the card:
  "Add bound to your Home Screen to get leave-by alerts." Android uses the `beforeinstallprompt`
  event; iOS gets the two-step instruction (Share, Add to Home Screen), because Safari has no
  prompt.
- Dismissing it is remembered in localStorage and it does not come back.

## Acceptance criteria

- [ ] Chrome's installability check passes for the deployed site, shown in the PR
- [ ] the offer appears once, after the first save, and never again after it is dismissed
- [ ] in standalone mode (already installed) the offer never appears
