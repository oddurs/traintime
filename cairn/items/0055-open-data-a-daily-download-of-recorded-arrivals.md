---
id: 55
uid: d18170cf-f79d-4261-8b14-3df3dca9f89e
title: 'Open data: a daily download of recorded arrivals'
type: feature
status: backlog
milestone: record
depends_on:
- 54
created: 2026-11-07
updated: 2026-11-07
priority: p2
effort: m
area: data
---

## Problem

A researcher who wants a month of arrivals has to page through the replay endpoint.

## Proposal

The poller writes one compressed CSV per service day of recorded arrivals: trip, route,
direction, station, predicted arrival, actual arrival. It is listed at /v1/data/ with each file's
size and its schema, and old files are kept as long as the events are (365 days).

## Acceptance criteria

- [ ] yesterday's file exists by 04:00 New York time, and its row count matches the recorded arrivals for that day
- [ ] the schema is documented on /api-docs/
