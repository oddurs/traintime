---
id: 11
title: Settle the fan curve before it is baked into GLSL
type: docs
status: done
milestone: render-2
assignee: claude
created: 2026-09-17
updated: 2026-09-18
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

- [x] The colour-to-metric blend is confirmed as-is, or deliberately changed
- [x] The crossover zooms are stated as intent rather than inherited constants
- [x] The curve is written down in closed form, once
- [x] Recorded as a note on this item, so the reasoning outlives the decision

## Confirmed as-is; the curve, and which numbers are actually chosen

Decision: keep the curve. It is already closed-form in JS — the duplication
that causes the width drift is only the fifteen-stop MapLibre expression that
approximates it, and render-3 deletes that. There is nothing to fix in the
curve itself.

The closed form, now written on fanAt() in src/lib/layout.ts:

  geo(z)    = TRACK_M / metresPerPixel(z)
  reveal(z) = smoothstep((z - 13.4) / (14.2 - 13.4))
  colour(z) = (1 - reveal) * 11
  metric(z) = max(reveal * 11, geo) - geo
  offset    = cb * colour(z) + mb * metric(z), and the geometry adds mb * geo(z)

Sampled, to show the three regimes are what they claim:

  zoom   colour   metric     geo   total px/band
  13.4    11.00     0.00    0.42        0.42
  13.8     5.50     4.95    0.55        5.50
  14.2     0.00    10.27    0.73       11.00
  16.0     0.00     8.46    2.54       11.00
  18.0     0.00     0.83   10.17       11.00
  18.115   0.00     0.00   11.01       11.01
  20.0     0.00     0.00   40.66       40.66

Between 14.2 and 18.1 metric + geo is exactly 11.00 px per band, which is the
property worth protecting: the two terms are tuned against each other so the
total stays on target rather than drifting.

Only two numbers in this are chosen: 13.4 and 14.2, the reveal window, and the
reason it is under one zoom level is already written down — spread over three,
the 4, 5 and 6 spent the mid-range two to seven pixels apart, far enough to
look wrong and not far enough to read as three lines.

The third crossover is not a choice at all. metric(z) reaches zero where
TRACK_M / metresPerPixel(z) reaches TARGET_PX, which is
z = log2(156543.03 * cos(40.73) * 11 / 4.6) = 18.114. It moves only if the
track spacing or the target spacing moves. It had never been stated, which is
the one thing this item actually changed.
