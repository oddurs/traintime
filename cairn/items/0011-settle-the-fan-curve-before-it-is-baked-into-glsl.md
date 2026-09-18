---
id: 11
title: Settle the fan curve before it is baked into GLSL
type: docs
status: backlog
milestone: render-2
created: 2026-09-17
updated: 2026-09-17
priority: p0
effort: s
area: map
---

## Problem

`fanAt()` blends a **colour** fan — one line per trunk, the printed-map
convention — into a **metric** one at the real 4.6 m track spacing, via a
smoothstep between roughly zoom 12 and 15. Past about zoom 18 the real metres
exceed the target, the fan falls to nothing, and the lines stand exactly where
the track does. That behaviour is good and worth keeping.

But it is currently expressed **twice**: as a JS function and as a fifteen-stop
MapLibre expression approximating the same curve. That duplication is the width
drift in render-3, and in a shader it collapses to one closed-form function with
no stops at all.

This is a design question, not a technical one, and it wants answering before the
answer is compiled. After render-3 there is exactly one place the curve lives,
which is the point — but it also means changing it later is a shader change.

## Acceptance criteria

- [ ] The colour-to-metric blend is confirmed as-is, or deliberately changed
- [ ] The crossover zooms are stated as intent rather than inherited constants
- [ ] The curve is written down in closed form, once
- [ ] Recorded as a note on this item, so the reasoning outlives the decision
