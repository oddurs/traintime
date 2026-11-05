---
id: 15
uid: 247f1eb9-2214-483c-98e2-45b4387e5994
title: Casing margin drifts because width and offset sample different curves
type: bug
status: dropped
milestone: render-3
depends_on:
- 13
created: 2026-09-17
updated: 2026-09-18
priority: p1
effort: m
area: map
---

## What happens

The casing interpolates `10 -> 2.3, 13 -> 3.9, 16 -> 6.6` and the stroke
`10 -> 1.1, 13 -> 2.3, 16 -> 4.2` (TrainMap.tsx:507, :517) — three stops each.
The offset interpolates across fifteen (`FAN_STOPS`, layout.ts:142). Between
stops, two piecewise-linear approximations of two different curves diverge, so
the casing margin breathes and the band spacing moves against it as you zoom.

The margin should be a stated quantity — "the casing reads one and a half pixels
wider than the stroke" — not an emergent difference between two interpolations.

## Acceptance criteria

- [ ] Casing width is derived from stroke width plus a stated margin
- [ ] Both are continuous functions of zoom, with no stop table
- [ ] The margin holds to within a pixel across zoom 10 to 20, checked by sampling

## Measured: there is no drift here

Dropped: the premise does not survive being computed.

Width and offset are independent quantities — one sets a line's thickness, the
other its position — so there is no interaction between them that could make a
casing margin breathe. And the two width curves use the *same* three stops as
each other, so they cannot drift apart between stops either.

The per-side margin, exactly:

  zoom    10     11     12     13     14     15     16    17+
  line   1.10   1.50   1.90   2.30   2.93   3.57   4.20   4.20
  casing 2.30   2.83   3.37   3.90   4.80   5.70   6.60   6.60
  margin 0.600  0.667  0.733  0.800  0.933  1.067  1.200  1.200

Monotonic, smooth, flat above zoom 16. A thicker line gets a proportionally
thinner casing, 0.545 of line width at zoom 10 down to 0.286 at 16, which reads
as a deliberate taper rather than a defect.

The measurement did find a real four-pixel error while looking for this one,
but it is in the offset sampling and not the widths. Filed as 0019 and fixed
there rather than stretched to fit this item's title.
