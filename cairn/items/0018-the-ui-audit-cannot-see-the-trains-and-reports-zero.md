---
id: 18
title: The UI audit cannot see the trains and reports zero
type: bug
status: backlog
created: 2026-09-17
updated: 2026-09-17
priority: p1
effort: s
area: map
---

## What happens

`scripts/audit-ui.mjs:125` and `:128` count trains with:

    __tt.map.queryRenderedFeatures({layers:["trains"]}).length

`trains` is a *source* name, not a layer — the only layer drawn from it is
`train-highlight`, the selection ring. And the trains themselves are a custom
WebGL layer (`trains-gl`), which has no features to query at all, so this can
never return anything.

Both steps therefore report `{"trains":0}` and raise a console error on every
run:

    Error: The layer 'trains' does not exist in the map's style and cannot be
    queried for features.

This has been true since 5dee9be moved the trains off GeoJSON;
`scripts/audit-ui.mjs` last changed in 221629e, which is an ancestor of it. So
the audit has spent that whole time unable to see the thing those two steps
exist to check — and a genuine "no trains are drawn" regression would look
exactly like the passing output it produces today.

## Reproduction

    npm run audit:ui        # or node scripts/audit-ui.mjs

Steps "deep zoom render" and "zoom out to whole system" both report 0 trains
and contribute the two problems in the summary.

## Acceptance criteria

- [ ] The two steps assert something that is actually true of the GL layer
- [ ] A map drawing no trains fails the audit rather than passing it
- [ ] The console error is gone, so the problem count reflects real problems
- [ ] Verified by checking it fails when the train layer is deliberately disabled
