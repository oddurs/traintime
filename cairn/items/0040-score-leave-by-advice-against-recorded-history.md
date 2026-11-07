---
id: 40
uid: d359f541-f3f1-4753-8700-725408452a80
title: Score leave-by advice against recorded history
type: feature
status: backlog
milestone: commute
depends_on:
- 39
created: 2026-11-07
updated: 2026-11-07
priority: p1
effort: m
area: data
---

## Problem

Leave-by is advice, and advice can be measured. The accuracy page already scores arrival
predictions against what trains actually did (scripts/evaluate.ts). Advice that has never been
scored is a claim.

## Proposal

`scripts/evaluate-leave.ts` replays recorded days. At sampled moments it computes `leaveBy` for
a set of stations at three walk times (3, 8 and 15 minutes), then checks the recorded arrivals:
did the named train reach the platform after the rider would have? It reports:

- the share of advice that held;
- how long riders waited on the platform (median and p90);
- the share where an earlier train was catchable but not named.

The figures go into public/data/accuracy.json, under `leaveBy`, and onto the accuracy page.

## Acceptance criteria

- [ ] the script runs over a recorded day in the repository's data/ copy and prints the three figures
- [ ] the accuracy page shows them with a sentence on what each means
- [ ] the margin `leaveBy` uses (1σ) is noted on the item with the figures that justify it, or changed if they do not
