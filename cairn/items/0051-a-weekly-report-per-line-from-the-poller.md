---
id: 51
uid: 4f7dc4f4-d288-4761-9373-b9c984751506
title: A weekly report per line from the poller
type: feature
status: backlog
milestone: record
depends_on:
- 50
created: 2026-11-07
updated: 2026-11-07
priority: p0
effort: m
area: poller
---

## Problem

The recorded history can say how each line ran this week compared with its normal, but only an
hour at a time, through /lines. A report card needs a week, aggregated, with the same definition
every week.

## Proposal

`GET /v1/report?week=2026-W45` returns one entry per line:

- median and p90 headway against the baseline the spike defined, per period (am peak, midday,
  pm peak, evening, weekend);
- minutes trains spent held;
- the number of delay alerts;
- the three worst hours, with the stretch of line they were on.

The report is computed once a week, after the week ends, and stored, so it never changes after
publication. A week with too little data says so per line, rather than reporting zeros.

## Acceptance criteria

- [ ] the endpoint returns the report for a past week from stored output, and the same request returns identical bytes every time
- [ ] a line with too little data in a period is marked as such, not reported as zero
- [ ] covered by a test over a fixture week, including a line held for an hour
