---
id: 54
uid: 77d92c8a-ee09-4fbf-9f74-04233f540f37
title: 'A stable API for researchers: versioned, documented, rate-limited'
type: feature
status: backlog
milestone: record
created: 2026-11-07
updated: 2026-11-07
priority: p1
effort: m
area: api
---

## Problem

The poller's endpoints are what the app happens to use: /state, /stream, /replay, /recordings,
/density, /lines, /timing. They are documented at /api-docs/, but have no version, no promise of
stability and no limits, so anyone building on them is building on something that can change
under them.

## Proposal

- Serve the public subset under /v1/: state, lines, report (once it exists) and replay. Keep the
  existing paths as aliases for the app.
- Write the stability promise on /api-docs/: fields are added and never removed within v1.
- Rate-limit per IP, with a 429 and a Retry-After header.
- Use the same CORS policy as today.

## Acceptance criteria

- [ ] /v1/state and /v1/lines return the same payload as their unversioned paths, covered by a test
- [ ] a client over the limit receives 429 with Retry-After, covered by a test
- [ ] /api-docs/ states the v1 promise and the limits
