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

## render-2 — one fan, and what it turned out to be worth

The fan is now computed once, in the vertex shader, from the camera the frame is drawn with. The
band coefficients and the track's own direction ride in the instance buffer; `fanned()`,
`fanScale`-on-the-frame-path and the per-train trigonometry are gone.

Measured with `npm run audit:fan`, which needs no access to the GPU: record the zoom a
`requestAnimationFrame` callback sees and the zoom the `render` that follows it sees, pair them, and
evaluate the real `fanAt` at both. That difference *is* the error the old code committed.

```
cpu   mean      p95      max      (lateral px, band two tracks out, zoom 14.4 -> 17.2)
1x    0.08     0.19     0.70
4x    0.09     0.21     0.80
8x    0.09     0.35     0.75
```

And the second error, the rate-limited heading used as the offset basis, sampled over 162 moving
trains at zoom 14:

```
|bearing - tangent|   mean 0.10°   p50 0.00°   p95 0.87°   max 2.07°
lateral equivalent    mean 0.03 px             p95 0.26 px  max 0.63 px
trains off by >5°     0 of 162
```

Both are now zero by construction — one reading of the camera, and the true tangent rather than the
damped heading. The cost side:

```
                  render-1   render-2
mean cb              1.20 ms    1.05 ms   (1.15x)
mean main ms/fr      7.93 ms    7.50 ms   (1.06x)
stride              64 B       80 B       per train, two slots spare for render-4
```

### This milestone was justified on the wrong grounds

The plan said the trains swim off their lines and that this was the cause. They do, and it was
worth fixing, but **the error is sub-pixel** — under a pixel at the ninety-fifth percentile even
with the CPU throttled eight times, against a fan that is eleven to seventeen pixels wide. Nobody
has ever seen it.

What render-2 actually buys, stated without inflation:

- One derivation instead of two, so render-3 can stroke the lines from the same function rather
  than a fifteen-stop approximation of it. This is the real reason to have done it, and it is
  structural rather than visible.
- The offset basis is the track's direction rather than a heading that is deliberately damped for
  the benefit of an arrowhead. Correct for a reason that survives someone changing the damping.
- About 13% off our own frame callback, which was already cheap.
- A stride with room for the arc-length render-4 needs.

It is not a visible improvement, and the honest place to look for the jank the complaint names is
render-3: the casing margin drifting because width samples three zoom stops and offset samples
fifteen, and `line-offset` displacing vertices that were tessellated for the un-offset centreline.
Neither of those has been touched yet.

## render-3 — the widths, and what was actually wrong with them

Both of this milestone's stated defects were checked before any of it was built. One did not
survive; the other was real, larger than anything render-2 chased, and had nothing to do with what
the plan said it was.

### The casing margin does not drift

The claim was that width samples three zoom stops while offset samples fifteen, so the casing margin
breathes between them. Width and offset are independent quantities — one sets thickness, the other
position — so there is no interaction that could make a margin breathe, and the two width curves use
the *same* three stops as each other. Computed exactly:

```
zoom    10     11     12     13     14     15     16    17+
line   1.10   1.50   1.90   2.30   2.93   3.57   4.20   4.20
casing 2.30   2.83   3.37   3.90   4.80   5.70   6.60   6.60
margin 0.600  0.667  0.733  0.800  0.933  1.067  1.200  1.200   per side
```

Monotonic, smooth, and flat above zoom 16. A thicker line gets a proportionally thinner casing —
0.545 of line width at zoom 10 down to 0.286 at 16 — which reads as a deliberate taper, not a bug.
Nothing here shimmers.

### The fan the renderer draws strayed four pixels from the fan itself

The real defect, and it is the one a viewer would describe as the widths going janky while scrolling
in. `bandOffsetExpression` samples `fanAt` at a hand-written list of fifteen zooms and lets MapLibre
draw straight lines between them. Those samples were placed for the reveal and left one per zoom
level everywhere else — and a chord across a steep stretch of a smoothstep is nowhere near it.

Measured over the zoom range the map can actually reach (`minZoom` 9.5, `maxZoom` 17), for one
four-track corridor — the A's, spanning bands −3.469 to +3.469:

```
                          worst corridor-width error     worst single band
15 hand-picked stops           4.16 px at zoom 13.50       2.08 px
41 adaptive stops              0.17 px at zoom 15.43       0.10 px
```

Zoom 13.50 is where it peaks, and that is the worst place for it to be: 13.4 to 14.2 is the reveal,
where a trunk stops being one line per colour and becomes one line per service. The chord from the
13.4 sample to the 13.6 sample overshoots the curve by four pixels, so **the corridor springs open
early and then settles back** exactly as you scroll through the split. Through 15.4 to 16.6 it runs
half a pixel to one and a half pixels narrow.

It mattered more than a list of stops sounds like it should, because since render-2 the trains do
not go through this list at all — they carry their band into the shader and are offset by `fanAt`
itself. Every pixel between the samples and the curve was a train sitting that far off its own line.
At 2.08 px for the worst band that is five times the camera staleness render-2 was built to remove,
it is there at rest rather than only during a gesture, and it is at a zoom people use.

The fix is not a better hand-written list. `buildFanStops()` pins the three places the curve is not
smooth — the reveal opening at 13.4, closing at 14.2, and the geometry taking over at 18.114 — and
bisects each gap until linear interpolation is inside a tenth of a pixel for the largest bands the
network contains. Forty-one stops, and two tests hold it: one on the tolerance, one checking the
bounds still cover the real network, because a corridor gaining a track would quietly widen the
bands past what the stops assume.

### Built anyway, and here is what it cost

The above was the recommendation; the instruction was to build it, so it is built. `lineGeometry.ts`
bakes the 2 950 strokes into a static interleaved buffer — 52 546 vertices, 139 938 indices, 3.06 MB,
24 ms once at load — and `lineLayer.ts` strokes them in a shader that calls the same `fanAt` the
trains do.

What went with it: eighteen GeoJSON line layers, the `routes` source, `routeLines()`,
`bandOffsetExpression`, `FAN_STOPS`, and the whole adaptive-stop apparatus from the section above.
That machinery existed to bound the error in sampling a curve for a style expression. There is no
sampling now, so it lived for exactly one commit — which is the right lifetime for scaffolding
around something you are about to remove.

A polyline is expanded in the vertex stage, not on the CPU: each vertex carries the point before and
after it so the shader can work out the direction of a bend **in screen space**, which is where a
pixel is defined. The band offset and the half width are then both applied along the same miter, to
geometry that knows which way the line is turning — rather than displacing vertices tessellated for a
line somewhere else. Ends carry a duplicate pair of vertices pushed out by the half width, which is
what lets the fragment stage round a cap instead of squaring it.

```
                                  main ms/fr    fps
eighteen GeoJSON layers (render-2)     7.50     27.7
ours, eighteen draws                   9.63     22.7
  + viewport culling                   8.83     26.1     recovered 8%
  + nine instanced draws               8.42     27.3     casing and line as two instances
```

**The performance criterion is not met.** At 8.42 against 7.50 the custom layer is 1.12× slower here,
and that is the honest number. Two things about it are worth knowing and neither is an excuse:

The harness rasterises in software, so every GL call is charged to the main thread — which is exactly
the thread this column measures. Moving work from MapLibre's pipeline onto the GPU therefore looks
like a regression whatever the GPU would have done with it. On real hardware the same change plausibly
goes the other way, and **that is a measurement this harness cannot take.**

And the gap is fill and draw-call bound rather than vertex bound: dropping the casing pass — half the
draw calls, most of the filled pixels — lands at 7.51, within noise of MapLibre. Culling fifty
thousand vertices down to what is on screen bought only 8%. MapLibre's line shader is simply better
optimised than a first version of one, which is what it should be.

One optimisation was reverted after measuring: narrowing the antialiasing extension from one pixel to
half a pixel — strictly less fill — made it *2.7× slower*, reproducibly. That is a software-rasteriser
pathology rather than a fact about the code, and chasing it further would be tuning for a renderer
nobody uses.

### What the screenshot caught that nothing else would

Every casing in the network drew magenta at three quarters opacity, and the map looked subtly,
unplaceably wrong rather than broken. `--map-casing` is authored `#000000`, computes to `#000`, and
the colour parser only knew the six-digit form — so it fell through to its "cannot read this" colour.
No type checker, no test and no audit would have found it; a screenshot found it in one look. There
is a test for it now.

### The custom line layer is not justified by any of this

`0012` and `0013` were filed to own the weave geometry so "widths stop shimmering and joins come out
right". Neither half now stands on its own evidence. The widths were the sampling, fixed above. The
joins were inspected at the tightest thing in the network — the A/C's ninety-degree turn at Broadway
Junction, at zoom 14.3, where an eleven-pixel offset is comparable to the curve radius in pixels —
and the parallel bands hold their spacing through the bend with no pinching or crossing.

That was the recommendation, and it was overruled deliberately — see above, where it is built. The
reasoning is left standing because the evidence has not changed: the widths were the sampling and the
joins were fine, and the case for owning the geometry is render-4's arc-length and retiring the last
CPU copy of the fan, not the complaint this all started with.

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
