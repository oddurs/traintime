# Rendering the map

What a gesture costs, how it is measured, and what the four render milestones change.

## The procedure

```sh
POLLER_URL=https://traintime-production-6a7d.up.railway.app npx next dev -p 7117
npm run audit:frames            # add --json to keep a run for comparison
npm run audit:ring              # the selection ring still follows its train
```

Twelve scenarios: idle, a drag, and scrolling in, at zoom 11 and 16, at 1× and 4× CPU. Four seconds
each, driven through CDP as real input events so they take the path a hand does. The camera comes
from the URL hash (`#@=lat,lon,zoom`), which is how every view in this app is addressed, so the same
script runs against a production build. Counters are off unless asked for, by `?perf=1` — a
measurement you can only take in the dev server is a measurement of the dev server.

Two traps, both of which produced wrong numbers before they were found, and both now guarded:

- **Two URLs differing only in the fragment are a same-document navigation.** The app never
  remounts, `readHash()` never runs, and the camera stays where the last scenario left it. The first
  version of this script navigated that way, so every row after the first was measured at whatever
  zoom the previous group's scroll-in had reached — about 19 — while the label said 11 or 16. The
  script now carries a distinct `run=N` and reads `getZoom()` back, failing loudly if the camera is
  not where it was asked to be.
- **`main%` is not comparable across runs when the frame rate changes.** Removing the uploads raised
  the frames delivered in the same four seconds, so the main thread does more useful work in the
  same share of wall time and `main%` can rise while every frame got cheaper. The column to compare
  is **main ms/fr**.

### What is deliberately not the headline

**Frame rate.** The headless browser rasterises in software, so its frame rate is substantially a
fact about SwiftShader, and it varies by 2–3× between runs on a shared laptop. It is reported
because a consistent shift across all twelve rows is still worth seeing, but nothing here is
concluded from it alone.

## render-1 — before and after

Measured 18 September 2026, `next dev` on an M-series laptop against the live poller. The "before"
column is the same instrumented build with the two fixes reverted, so the only difference between
the columns is the change under test.

```
cpu  zoom  scenario     trains/fr      ribbons/s        main ms/fr          fps
                        before after   before  after    before  after  ×    before after
─────────────────────────────────────────────────────────────────────────────────────────
1x   11    idle           1.00   0.00      3.5    3.7       3.4    1.7  2.0    18.0  33.5
1x   11    pan            1.00   0.00     17.5    3.7       4.6    3.5  1.3    17.5  17.8
1x   11    scroll in      1.00   0.00     18.3    3.7       8.2    7.4  1.1    18.6  19.1

1x   16    idle           1.00   0.00     15.5   17.2       5.2    2.0  2.6    25.5  41.0
1x   16    pan            1.00   0.00     22.7   15.4       5.8    3.4  1.7    22.7  25.7
1x   16    scroll in      1.00   0.00     31.4   14.8       4.6    4.0  1.1    31.5  21.6

4x   11    idle           1.00   0.00      3.0    4.0      27.6    7.2  3.8    10.2  28.6
4x   11    pan            1.00   0.00     16.2    3.6      17.2   14.5  1.2    16.4  15.5
4x   11    scroll in      1.00   0.00     18.0    3.7      22.6   18.4  1.2    18.3  18.6

4x   16    idle           1.00   0.00     14.5   17.5      21.0    7.9  2.7    23.4  35.9
4x   16    pan            1.00   0.00     23.9   14.5      23.4   13.4  1.8    23.9  23.2
4x   16    scroll in      1.00   0.00     33.0   18.5      16.2   11.8  1.4    33.1  31.1

mean main ms/fr   13.31 → 7.93   (1.68×)
```

### The ring source: 1.00 → 0.00 uploads per frame

Every frame, at every zoom, throttled or not, moving or perfectly still, used to hand MapLibre a new
`trains` source. The comment at the call site justified it as "one or two features, so this stays
cheap at the frame rate", and the feature count was never the cost: a `setData` is a worker
round-trip, a re-parse and a source invalidation whatever it carries.

Nothing is selected most of the time, and that is the case worth winning — the content signature is
then the empty string and the source is left alone entirely. With a train selected the ring does
move and an upload is work that has to happen; `npm run audit:ring` asserts it still happens, and
measured 138 uploads over 164 frames following a train at 27 m/s. The 16% of frames it skipped were
the ones where the train had slowed below a tenth of a metre per frame.

### The ribbon clock: the gesture no longer changes it

`ribbons/s` is the number to read here, not `ribbons/fr`, because the frame rate moved.

```
              before (idle / pan / scroll)     after
1x zoom 11       3.5  17.5  18.3                3.7   3.7   3.7
4x zoom 11       3.0  16.2  18.0                4.0   3.6   3.7
1x zoom 16      15.5  22.7  31.4               17.2  15.4  14.8
4x zoom 16      14.5  23.9  33.0               17.5  14.5  18.5
```

`drawInterval` is 4.0 Hz at zoom 11 and 20.7 Hz at zoom 16. Before, a gesture pushed the rate to
4–6× the clock at zoom 11 and to 1.5× at zoom 16; after, all three scenarios sit on the clock, and
at zoom 11 they land on it exactly. That is the `map.isMoving()` term removed: a ribbon is
`LonLat[]`, so moving the camera does not change it and MapLibre reprojects what it already has for
free.

## Scorecard

| target | result |
|---|---|
| `trains/fr` ~0.00 with nothing selected | **met** — 0.00 in all twelve rows |
| `ribbons/s` under a gesture no higher than at rest | **met** — flat on the clock; exact at zoom 11 |
| `cb mean` unchanged by this milestone | **met** — 0.4–2.4 ms, as before |
| `main%` on zoom 11 scroll-in below idle + 2 points | **not met, and the target was wrong** |

The last one deserves its own line rather than a footnote. Scrolling in still costs 14% against a
5% idle, and it always will: zooming loads tiles, re-tessellates them, and speeds up the rebuild
clock because `drawInterval` is zoom-dependent by design. None of that is ours to remove in this
milestone, and a target phrased against idle conflated our pipeline with everything the map does
during a zoom. Per frame the same scenario went 8.2 → 7.4 ms, which is the honest figure.

## What the measurement corrected in the plan

**Our own frame callback was never the problem.** `cb mean` is 0.4–0.6 ms at 1× and 1.5–2.4 ms at
4×, and no frame in any scenario spent 8 ms there. The plan had assumed per-train CPU work in the
frame loop was worth attacking for its cost. It is not. `render-2` is still worth doing, but the
case for it is that the fan is derived from a stale camera and the trains sit off their lines — a
correctness argument, not a performance one, and it should be argued that way.

That is why `cb` is reported at all: it is the column that says the callback is innocent, and it
should keep saying so through `render-2` and `render-3`.

## Still to come

`render-3` is the first milestone that changes what the GPU is asked to draw rather than what the
main thread is asked to prepare, so it is the first where a frame rate is the right measure — and
this harness cannot give one, because it rasterises in software. That will want a real-hardware
measurement, and the target should be set when there is a way to read it.
