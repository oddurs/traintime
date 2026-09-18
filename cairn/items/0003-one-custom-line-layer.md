---
id: 3
key: render-3
title: One custom line layer
type: milestone
status: backlog
created: 2026-09-17
updated: 2026-09-17
priority: p2
---

Own the weave geometry, so widths stop shimmering and joins come out right.

The real work of the four.

Two things are wrong with drawing the weave as eighteen GeoJSON layers. The
widths interpolate across three zoom stops while the offset interpolates across
fifteen approximating a smoothstep — two piecewise-linear fits of two different
curves on two different stop sets, so the casing margin and the band spacing
drift against each other between stops. And `line-offset` displaces vertices that
were tessellated for the *un-offset* centreline, so joins and miters were solved
for a line that is not the one being drawn: on tight subway curves the offset
pinches and self-crosses, and the magnitude changes continuously with zoom while
the tessellation only changes at tile boundaries.

Both go away when the geometry is ours and the offset is applied in the same pass
as the trains', from the same uniforms.
