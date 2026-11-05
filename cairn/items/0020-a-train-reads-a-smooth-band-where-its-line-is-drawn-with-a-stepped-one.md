---
id: 20
uid: 7215d848-48ae-4b04-b611-a5bdc823bd21
title: A train reads a smooth band where its line is drawn with a stepped one
type: bug
status: backlog
milestone: render-4
created: 2026-09-18
updated: 2026-09-18
priority: p1
effort: m
area: map
---

## What happens

The band is read two ways. A train takes it from `bandsAlong`, the continuous
profile the geometry is swept along. Its line is drawn from `strokes()`, which
cuts that profile into pieces wherever it has drifted `BAND_STEP` (1/16 of a
band) since the piece began, and draws each piece at the mean of its two
endpoint bands.

So the train follows a curve and the line follows a staircase fitted to it, and
they part company by half a step — by design, and documented as "about 0.7 px, a
fifth of the width of the line itself".

Measured over 11 752 points at zoom 15, run-matched so each stroke is compared
against its own run's profile:

  p50   0.304 px      <- exactly BAND_STEP/2, which is the design
  p90   0.728 px
  p99   1.274 px
  p999  3.211 px
  max   4.615 px      (R#5 G20->G21 at 90% of the stretch)

  over 0.7 px   1215 samples (10.3%)
  over 2 px       49 samples (0.4%) — 92% of them within 15% of a stretch end

The design bound holds for ninety percent of the network. The tail does not, and
it is not spread evenly: it collects in the band ramps either side of a station,
which is where the profile moves fastest and where the map is already hardest to
read. 4.6 px is more than a line width.

Why the tail exceeds BAND_STEP/2 is not yet explained. The cut rule bounds the
drift within a piece at one step, so half a step should bound the error, and
something about pieces spanning a segment boundary or a ramp does not fit that.
Finding out is the first half of this item.

## Acceptance criteria

- [ ] The reason the tail exceeds the design bound is found and written down
- [ ] A train takes the band its own drawn piece carries, not the smooth profile
- [ ] Worst case at zoom 15 is inside the stated bound, across the whole network
- [ ] A test holds it, so a change to the cutter cannot quietly reopen it
