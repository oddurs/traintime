---
id: 3
uid: a2fa4fb7-f76a-4e46-b47a-74bad1294445
key: render-3
title: One custom line layer
type: milestone
status: done
created: 2026-09-17
updated: 2026-09-18
priority: p2
---

Make the drawn fan match the real one; the geometry turned out not to be the problem.

Filed as the real work of the four, on two claims: that line widths shimmer
because width and offset sample different zoom stops, and that `line-offset`
displaces vertices tessellated for the un-offset centreline so joins pinch on
tight curves. Both were checked before anything was built, and neither survived.

The casing margin is monotonic and smooth, and line and casing use the *same*
three stops, so they cannot drift against each other — 0015, dropped. The joins
hold their spacing through the tightest turn in the network, the A/C's ninety
degrees at Broadway Junction at zoom 14.3, where an eleven-pixel offset is
comparable to the curve radius in pixels.

What the measurement did find is that the renderer's *sampling* of the fan was
four pixels off the curve at zoom 13.50 — the exact moment a trunk splits into
its services — and since render-2 the trains are offset by `fanAt` itself, so
that gap was also a train sitting off its own line, at rest. Fixed in 0019 by
choosing the stops against the curve rather than by hand.

0012 and 0013 stay open on different grounds: render-4 needs a line vertex
buffer to resolve arc-length against, and the selection ring and platform counts
are still positioned by longitude and latitude, which is the last copy of the fan
sum living on the CPU.
