---
id: 50
uid: 72aa401c-758a-440b-a07c-70255853c939
title: What 'normal' means for a line, and how much history a weekly report needs
type: spike
status: backlog
milestone: record
created: 2026-11-07
updated: 2026-11-07
priority: p0
effort: s
area: data
---

## Question

A report card says "the F was 34 % slower than its normal". Which normal is that, and is it the
same one the Lines group's headway table uses (headwayRatio from the poller's /lines endpoint)?
Is it stable enough to publish weekly without crying wolf?

## Leading hypothesis

Normal is the median headway for the same line, direction, hour and weekday type over the
previous four weeks. The poller keeps events for 365 days, so four weeks are always there. A
week-on-week change under 10 % is noise, and the report should say "normal" there.

## How to answer it

- Read how /lines computes headwayRatio today (services/poller).
- Compute the four-week baseline for every line over the history in data/.
- Measure how much a week varies from the one before when nothing happened.
- Write down the definition, the noise floor and any line with too little data.

## Acceptance criteria

- [ ] the Answer section below says what was found, with the evidence
- [ ] the items the answer calls for exist and depend on this one

## Answer
