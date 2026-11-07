---
id: 58
uid: 0c7348c6-0883-439b-9a94-32dfb4abd2d8
title: Step-free status on a station's board
type: feature
status: backlog
milestone: reach
depends_on:
- 57
created: 2026-11-07
updated: 2026-11-07
priority: p2
effort: m
area: front-end
---

## Problem

A rider who cannot use stairs finds out at the station that its elevator is out.

## Proposal

The spike settles what can be said. As planned before it:

- a station board shows a line under the station name when an elevator or escalator there is
  out: "Elevator to the downtown platform out of service · back about 4 pm";
- the line has a mark, not coloured text;
- saved stations show the same line on home.

Refine this body from the spike's answer before starting.

## Acceptance criteria

- [ ] a station with a current outage in the feed shows the line on its board and, if saved, on home
- [ ] the line names what is out and which platform it serves, to the extent the spike found the data supports
