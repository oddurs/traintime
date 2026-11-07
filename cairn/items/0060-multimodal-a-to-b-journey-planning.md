---
id: 60
uid: 8a1f761b-3dc2-44f0-bcab-d7ec598d43ff
title: Multimodal A-to-B journey planning
type: feature
status: dropped
milestone: reach
created: 2026-11-07
updated: 2026-11-07
priority: p3
area: front-end
---

## Decision

Not built, by choice.

General journey planning, from an address to an address across walking, buses and the subway, is
what Google Maps, Apple Maps and Citymapper do, with schedules, street data and years of tuning
bound does not have and should not try to match.

bound stays on the decisions where its own data is the edge:

- which train to leave for (0039);
- whether a transfer is worth it (0044);
- where your train is when the feed goes quiet (0049).

The destination picker on a station board is the limit: one origin, one destination, subway only.

Reopen only if a spike shows the subway-only answer is wrong for a large share of riders' real
trips.
