---
id: 57
uid: a7ea9a1c-dd5a-44c5-9a3a-1a675ba1e71c
title: What the MTA's elevator and escalator feed says, and what step-free travel needs
type: spike
status: backlog
milestone: reach
created: 2026-11-07
updated: 2026-11-07
priority: p2
effort: s
area: data
---

## Question

The MTA publishes elevator and escalator outages, current and planned. What does it contain,
how reliable is it, and is it enough to say whether a station can be used without stairs right
now?

## Leading hypothesis

The feed lists each equipment id, its station, whether it is out and an estimated return. With a
map from equipment to the path it serves (street to mezzanine, mezzanine to which platform),
bound can say "no step-free route to the downtown platform" — and the map from equipment to path
is the hard part.

## How to answer it

- Fetch the feed for a week.
- Count outages and how often the estimated return is right.
- Check whether the MTA publishes which platform each elevator serves.
- Try to state the step-free status of five complex stations by hand.

## Acceptance criteria

- [ ] the Answer section below says what was found, with the evidence
- [ ] the items the answer calls for exist and depend on this one

## Answer
