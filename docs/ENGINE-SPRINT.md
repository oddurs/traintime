# Making the location engine smarter

*31 August 2026.* The engine had one job it was doing on inference alone: saying where a train is
between two platforms. This sprint went looking for signals in the feeds that we were discarding,
measured each one before building on it, and kept the results — including the one that lost.

## The three signals we were throwing away

### 1. `INCOMING_AT` is a position measurement, and the only one there is

Every other thing the engine knows about an intermediate position is inferred from predicted
times. `INCOMING_AT` is different: it is the feed telling us the train has entered its final
approach. We recorded it as an event and then ignored it.

| | |
|---|---|
| coverage | 90–97% of arrivals on the 1, 2, 4, 6, 7 · ~1% on lettered lines · **77,124 of 193,952 arrivals** |
| approach duration | median **13 s** (p16 5 s, p84 23 s) across 376 stops |
| share of the run | cruise 31 s, approach 18 s — the approach is **36% of the total** |

A 36% phase of every run, unmodelled. It now flows feed → tracker → `TrainState.approach` and is
consumed by the kinematics as a forward-only position fix onto the braking curve that ends at the
platform in that platform's learned approach time.

*Forward-only* matters: a train never reverses, so when the marker is already past where the
measurement puts it the engine holds it and lets reality catch up rather than sliding it back.

### 2. The B division's heartbeat is a departure, after all

`docs/FEED-SEMANTICS.md` previously recorded that departures on the lettered lines are
unobservable, and the engine modelled them as arrival + a typical dwell learned from the numbered
lines. That was wrong, and the correction is the biggest single win here.

The vehicle timestamp advance is a **metronome, not a drift**: across 28,144 advances on
`gtfs-ace` the gap between them is 16 s at the 50th, 90th, 97th *and* 99th percentiles. It stops
dead when the train pulls out, so the value it froze at is a real feed timestamp for a real
departure.

Tested the only way that settles it — a better departure estimate must make the run times it
implies more *consistent*, since a given stretch of track takes what it takes:

| departure estimate | spread of implied run time |
|---|---|
| arrival + modelled dwell (before) | 30 s |
| the frozen heartbeat (now) | **17 s** |

Tighter on 488 of the 609 stretches where both could be scored, over 23,393 completed runs.

This also closes a hole nobody had noticed: the B division emitted **no departure events at all**
(76,571 departures recorded against 197,902 arrivals, every missing one from a feed that behaves
this way), so the lettered lines contributed no observed dwell and no observed run times. `/lines`
still reports `dwellP50: null` for the F. They do now.

### 3. A train that has not left its terminal is a different animal

The far horizon was the one place the app still lost to the MTA. Splitting the error on whether
the run had begun says why:

| horizon | started | not started |
|---|---|---|
| < 5 min | 33 s MAE, +18 s bias | 42 s, +41 s |
| 5–15 min | 66 s, +40 s | 16 s, −7 s |
| **> 15 min** | 58 s, +37 s | **118 s, +106 s** |

Trains still at their terminal are placed by schedule alone, and the schedule pads terminal
departures heavily — by 178–409 s depending on the terminal. Averaged in with running trains at
the coarse `route`/`all` levels, that padding had nowhere to go.

So the residual backoff chain gained a level of its own for them — a running train backs off along
its segment, one still at its terminal backs off along that terminal — mirrored in the trainer, plus
a `not_started` feature for the model. **877 terminal levels** were learned, and they agree with
the measurement exactly: `orig:726N|h4` learned **−301 s** against a measured +301 s bias,
`orig:L01S|h4` **−300 s** against +298 s. Terminals whose schedule is honest correctly learned 0.

## The one that lost, and why it is worth writing down

The heartbeat's accuracy made it tempting to use the beat to decide *whether* a train has left, not
just when: while the beat runs, the train is demonstrably still at the platform.

That is true, and it made the map worse. Confirming a freeze takes 45 s — the 16 s cadence plus
feed latency, with margin — and holding the marker for those 45 s cost far more than the better
timestamp gained:

| | marker short of platform (median) | p90 | already at platform |
|---|---|---|---|
| before | 185 m | 475 m | 16% |
| holding on the beat | **470 m** | 880 m | 4% |

So the beat's two roles are now split, which is the right shape anyway:

- **When to start the marker moving** — the modelled dwell, which errs early rather than late. The
  beat may only ever move a departure *earlier*, never later.
- **What time it actually left** — the frozen beat exactly, recorded as the departure event. Being
  45 s late to *know* costs nothing retrospectively, and the accuracy is worth everything: those
  events are what the modelled dwell is learned from. The loop closes on itself.

## What it measured

Scored over one bounded window (2.3 h, 25,071 arrivals, 5.9 M simulated train-seconds) against the
arrivals the feed itself went on to report. Cross-window comparisons are not valid here, so every
row below is the same window.

**Where the marker is at the moment a train really arrives:**

| | before | final |
|---|---|---|
| short of the platform, median | 185 m | **156 m** |
| short of the platform, p90 | 475 m | **458 m** |
| already at the platform | 16%, median 11 s early | **11%, median 7 s early** |
| times a train moved backwards | 0 | **0** |
| jumps faster than 40 m/s | 0 | **0** |
| fastest speed drawn | 27.0 m/s | 27.6 m/s |

**Arrival times**, with the terminal-aware tables and the retrained model:

| horizon | MTA | before | final | 1σ coverage |
|---|---|---|---|---|
| < 45 s | 30.1 s | 5.8 s | **5.7 s** | 90% |
| 45 s – 2 min | 41.2 s | 31.6 s | **31.0 s** | 66% |
| 2 – 5 min | 52.6 s | 39.4 s | **38.5 s** | 65% → **68%** |
| 5 – 15 min | 87.5 s | 70.4 s | **67.0 s** | 63% → **71%** |

Scored on trains that had not yet started their run — the population the terminal level exists for
— the far horizon improves far more sharply: **48.4 s → 31.4 s**, with coverage 68% → **83%**.

Two notes against misreading these:

- **An intermediate version scored better and was rejected.** Pulling the marker continuously
  toward a target that converged on the platform reached a median 137 m, but drew trains at
  39 m/s — 140 km/h, on a system whose trains do 89 — because nothing bounded the closing speed.
  A correction that is right about the position and wrong about the physics reads as a glitch, and
  `/accuracy` publishes "fastest speed drawn". The shipped version bounds closing speed by the
  line's own top speed and ramps it under an acceleration limit, costing 19 m of median accuracy
  to keep every drawn train physical.
- **Reported data latency rose from a p90 of 19 s to 44 s, and this is not a regression.** That
  figure is "how old is the information in an event we just received", and the B division's
  departures are now among those events — discovered up to a minute after the beat froze. Being
  late to *know* a departure costs nothing retrospectively, which is the whole reason the beat is
  used for the recorded time and not for the live phase.
