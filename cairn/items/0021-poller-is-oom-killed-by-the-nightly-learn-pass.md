---
id: 21
uid: 9ee26a5a-546b-48c8-ac5b-ccba75333c2e
title: Poller is OOM-killed by the nightly learn pass
type: bug
status: done
created: 2026-11-05
updated: 2026-11-06
closed_at: 2026-11-06
priority: p0
effort: s
area: poller
---

## What happens

The poller has been killed for running out of memory (`oom_killed`) at 03:20 New York time on most
nights since 2026-09-15: 07:20 UTC, 25 seconds after `[learn] starting nightly rebuild`. Railway
restarted it each time until deployment `5fc4d361` used up its 10 restarts on 2026-10-27. After
that it stayed `CRASHED` and recorded nothing for nine days.

The 1-minute memory samples never show the spike: they read 0.68 GB against an 8 GB limit. The
project event log (`events` in the GraphQL API) is what shows `oom_killed`.

Three DuckDB instances are open during the learn pass: the recorder's, `learnOnce`'s, and the
`learn-timing.ts` child it spawns. None sets `memory_limit`, so each one assumes it can use 80% of
the container. The held-out quarter is also read into JS objects all at once. The Python trainer
is the only part with a cap (512MB, `SET threads=2`).

## What should happen

Every DuckDB instance the poller opens has an explicit memory limit, and the limits added together
fit the container with room for the JS heaps. When a learn pass goes over, DuckDB spills to disk
instead of the kernel killing the recorder.

On Pro, also stop relying on 10 restarts: `restartPolicyType: ALWAYS`, so a crash a night is
visible but never turns into a permanent outage.

## Reproduction

1. `railway api 'query { events(projectId:"9bae41ff-2ad5-4e91-84fe-8df35e93bd90", first:100){ edges { node { createdAt action } } } }'`
2. Every `oom_killed` entry falls at 07:20 UTC or within minutes of it.

## Acceptance criteria

- [x] Every DuckDB instance in the poller and the scripts it spawns sets `memory_limit` and `threads`
- [x] A test fails if the configured limits add up to more than the container budget
- [x] `.railway/railway.ts` matches the live project: the volume is in `us-east4-eqdc4a`, `railway config plan` shows no destructive change
- [x] The restart policy is `ALWAYS`
- [x] The poller is redeployed and `/health` reports 8/8 feeds
- [x] One nightly learn pass completes on the new deploy without an `oom_killed` event
- [x] The learner over the full history peaks under 5 GB and finishes in under ten minutes
- [x] Two learner runs over the same history write identical tables

## 2026-11-05

Scope grew at the user's request ('optimize it generally'): the learner now filters and counts in DuckDB and streams rows; hierarchy build shares work across the four gate shapes; windows break ties fully so builds are repeatable. Full history (80 days): 16.8 GB and a heap crash before, 4.0 GB and 280 s after; whole learnOnce 351 s at 4.6 GB, adopted 40.5 s vs 42.2 s MAE locally. Old learner disagreed with itself run-to-run (86% of run hierarchy identical on 4 days); new agrees with old about as well, and with itself 100%.

## 2026-11-06

2026-11-06 03:20 learn on the Pro deploy: ADOPTED 43.8 s vs 44.4 s on 1,478,796 held-out observations, model retrained; no oom_killed in the project event log.
