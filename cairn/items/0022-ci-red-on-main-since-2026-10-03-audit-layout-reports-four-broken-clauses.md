---
id: 22
uid: 32204366-c994-4c63-9cd6-320bea7d9fbd
title: 'CI red on main since 2026-10-03: audit:layout reports four broken clauses'
type: bug
status: backlog
created: 2026-11-05
updated: 2026-11-05
priority: p1
area: map layout
---

## What happens

`npm run audit:layout` fails in CI on every push, `main` included, since `ff96ab9` (2026-10-03, run 37157620366). It runs before `build:pages`, so `build:pages` never runs in CI either:

```
=== BROKEN CLAUSES (4) ===
 [conjoined] two strokes of one service part by 4.6 m
 [conjoined] 2 of 220 band changes part by more than 2 m
 [ordered] a stroke steps 4.6 m at a seam — a stretch is drawn on the wrong side
 [apart everywhere] two services are drawn 0.0 px apart — 6/6X at 621-622 (zoom 14.5)
```

## What should happen

The four clauses hold, or the audit is changed on purpose with the reason recorded. Until then every PR is red, which hides a real regression in any other step.

## Reproduction

1. `npm run audit:layout` on `main`.

## Acceptance criteria

- [ ] `npm run audit:layout` exits 0 on `main`
- [ ] CI is green on `main`
