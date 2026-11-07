---
id: 31
uid: 8b2b16ee-a1a7-4f11-b715-fdaf379041fb
title: 'UX: back closes what you opened, recents in search, a train view for riders'
type: feature
status: done
milestone: render-4
created: 2026-11-07
updated: 2026-11-07
closed_at: 2026-11-07
priority: p1
area: front-end
effort: m
---

## Problem

Walked through on a phone against the live site:

- **Back left the app.** Every selection replaced the history entry, so the phone's back gesture, Android's back key and the browser's back button all left the site from a station or a train. Opening a station and then a train gave a history length of 2.
- **Closing a station left the card half open** over the map, wherever it had been before.
- **Focusing search showed the home content.** The card opened to full height and offered nothing until a letter was typed. A typed name with no match showed nothing at all.
- **The train view led with internals:**
  - a trip id in monospace under the title (`0L 1136+RPY/8AV · track 2`);
  - then a sentence about departure modelling;
  - then the next stop.

  Each stop read "±25 s · MTA is usually 18 s late here", and times mixed "35 s" and "2.4 min".
- **Boards repeated their caveats.** Every row said "give or take 32 s", including where the uncertainty changes nothing a rider does.
- **Map taps had to be exact.** A station dot is 3–13 px across and was hit-tested at the exact tap point.

## Proposal

- **History.** Opening a station or a train is a history entry (`openPlace`), and closing it goes back (`closePlace`). A popstate handler sets the app from the entry. Camera and filter changes still replace the entry and keep its depth.
- **The card** returns to the stop it was at before an answer raised it.
- **Search** offers saved and recent stations on focus, with a Clear for recents. It says when a typed name matches no station.
- **The train view, in a rider's order:**
  - where it is going;
  - where it is now ("At Lorimer St · leaves now");
  - Follow;
  - the next stop with its countdown and changes;
  - the stops, each "arrives 12:15 PM" with a time in minutes.

  How we know (provenance, MTA comparison, trip id, track) sits at the end, closed.
- **One time unit.** `fmtWhen` gives "now", "1 min", "12 min". `fmtSpread` gives "± 2 min", and only from a minute of uncertainty up.
- **Map taps** get a finger-sized target: 22 px for a train and 18 px for a station on touch, 14 and 8 with a pointer. The nearest mark wins, with trains first, through one click handler.

## Acceptance criteria

- [x] Opening a station, then a train, then going back twice returns to the train's station and then to the map, and the card returns to collapsed. Checked in the browser and by `audit-ui` on desktop and phone.
- [x] A history entry's depth survives camera and filter changes, and a station opened by a link closes in place. Covered by `tests/navigation.test.ts`.
- [x] Focusing an empty search field lists saved and recent stations, and recents can be cleared. A typed name with no match says so.
- [x] The train view shows no trip id or provenance sentence above the stops. Every time in it is "now" or a whole number of minutes.
- [x] No board or train row shows an uncertainty under a minute.
- [x] A tap within 18 px of a station, or 22 px of a train, on a touch screen selects it.
- [x] Tests, lint, typecheck and the audits pass, and the live site is checked after the deploy.

## 2026-11-07

Deployed as traintime-site c3927a22. audit-ui on a phone viewport against the live site: back steps train → station → map, focus offers recents, Follow toggles; 0 problems.
