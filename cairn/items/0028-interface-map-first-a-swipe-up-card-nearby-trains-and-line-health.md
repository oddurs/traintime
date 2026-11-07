---
id: 28
uid: 67f51c14-7b0d-4a4a-8799-b9317de3112f
title: 'Interface: map first, a swipe-up card, nearby trains and line health'
type: feature
status: done
milestone: render-4
created: 2026-11-07
updated: 2026-11-07
closed_at: 2026-11-07
priority: p2
area: front-end
effort: l
---

## Problem

On a 390 × 844 phone the collapsed sheet covered about 280 points of the map. It held the brand row, a Live chip, the search field, three full-height buttons (all, none, uncertainty), a history link and a footer bar. The map is the product, and a third of it was under chrome before anyone touched the screen.

- The sheet moved only from its grabber, and it jumped between stops instead of following the finger.
- The 25 line toggles were always open, as a wall of 30-point bullets.
- The map key was a large card on every first visit.
- To see trains near you, you had to pick a station. "Near me" opened the nearest station only, so you could not see what was arriving within walking distance.
- How the lines were running (headways against normal, held trains, delays) was hidden behind a "history" link.

## Proposal

- **Phone:** the collapsed card is the grabber and the search field only. The card follows the finger from anywhere on its head, and snaps to the nearest stop on release, with the drag's velocity taken into account. Focus on search opens it to full height.
- **Desktop:** a narrower floating card on the left. It is as tall as its content.
- **Floating map controls** at the top right: a location button, and a small status badge (Live, Replay, Connecting).
- **Nearby:** with location on, a section lists the stations within a chosen walking radius (5, 10 or 20 minutes), each with its next trains. The map draws the radius and your position, and rings the trains in the list.
- **Lines:** one collapsed row that summarises service, with the count of trains running, held trains and lines with delays. Opened, it holds the toggles, the uncertainty switch, the per-line headway health and the map key.
- **Type:** the scale follows Apple's sizes for each platform, not one scale multiplied: iOS sizes for a touch screen, macOS-like sizes for a pointer.

## Acceptance criteria

- [x] On a 390 × 844 phone, the collapsed card is no taller than 120 points, and the map takes the rest of the screen.
- [x] The card follows a drag on its head and snaps to the nearest stop, with a flick carrying it to the next stop.
- [x] The line toggles are collapsed by default, behind one row that shows trains running, held trains and lines with delays.
- [x] With location on, a Nearby section lists the stations within the chosen radius with their next trains, closest first. The map draws the radius and your position.
- [x] The nearby selection is covered by unit tests: the radius filter, the order, and the limit per station.
- [x] `npm test`, `npm run lint`, `npm run typecheck`, `npm run audit:design` and `npm run audit:layout` pass. The live site is checked on phone and desktop after the deploy.

## 2026-11-07

Measured on a 390 × 844 viewport against the live poller: the collapsed card is 67 pt tall (top at 777). The radii are 5, 10 and 20 minutes because 15 minutes is only 822 m at the board's walking pace, and the ten-minute circle around Times Sq holds two complexes. Headless Chrome delivers touch moves about 80 ms apart, too slowly to simulate a flick, so the snap rule is a pure function (src/lib/sheet.ts) with unit tests; a held drag was checked in the browser.

## 2026-11-07

Deployed as traintime-site 14550862. On the live site the collapsed phone card's top is at 777 of 844; Nearby at Union Sq listed 14 St-Union Sq and 3 Av with their next trains, and the radius and position drew on the map.
