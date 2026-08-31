# The poller: a calibration engine for the subway

The map is a rendering of a prediction. The prediction is the product. Everything that makes
traintime worth using — a train on the right track, a countdown you can trust, a σ that means
something — comes from the poller knowing how this stretch of track behaves *at this hour, on this
kind of day, in this weather, behind this train*.

Today it knows one thing: how a segment behaves on average, plus a global residual correction. That
is a good start and it already beats the MTA's own numbers. It is nowhere near what the data
supports.

## What the data can actually tell us

Observable, exactly, from the feeds:

| signal | what it licenses |
|---|---|
| arrival timestamps at every stop | run times, headways, dwell (where departures are reported) |
| `INCOMING_AT` → `STOPPED_AT` | the final approach, ~11–18 s, per station |
| the whole line's state at once | headway to the train ahead — our only crowding proxy |
| `actual_track` | express vs local, and reroutes, per stop |
| trip id → GTFS shape | the exact scheduled pattern, so "where did it come from" is not a guess |

Joinable from outside, free and without a key:

| source | why it matters |
|---|---|
| Open-Meteo hourly for NYC | rain and snow lengthen dwells and slow approaches; temperature affects everything |
| a calendar | a Tuesday in July is not a Tuesday in October; holidays run weekend-ish service |

Not observable, and no model can invent it: intra-segment speed, ridership counts, incident causes.

## The statistical shape

The problem is a hierarchy with wildly uneven data. "Southbound 4 from Grand Central at 08:15 on a
rainy Tuesday in March" may have five observations; "southbound 4 from Grand Central" has thousands.
Fitting the narrow cell alone overfits; ignoring it throws away the signal.

The right structure is **empirical-Bayes shrinkage down a backoff chain**. Each estimate is a
weighted blend of its own cell and its parent:

```
estimate = (n·cell + k·parent) / (n + k)
```

so a cell with plenty of data speaks for itself, and a thin cell quietly inherits its parent. The
chain for a run time:

```
segment × hour-of-week × weather-band
  → segment × hour-of-week
  → segment × daypart          (owl / am-peak / midday / pm-peak / evening)
  → segment
  → route × daypart
  → global
```

Dwell gets its own chain rooted at the station, because dwell is a property of the platform (how
many doors, how many transfers) far more than of the route:

```
station × direction × hour-of-week × weather
  → station × direction × hour-of-week
  → station × direction × daypart
  → station × direction
  → station
  → global
```

Every level carries `n` and a spread, so σ falls out of the same structure instead of being a
separate guess — and widens automatically in conditions we have not seen much of, which is exactly
when it should.

## Sprints

### B1 — Survive the year *(foundation, partly built)*

Per-feed exponential backoff with jitter, a circuit breaker so one sick feed cannot starve the
others, and **stall detection** — a feed whose header timestamp stops advancing keeps returning 200
with stale contents, which is the failure that looks healthy. Retention: raw ticks are the bulk and
the least reusable once events are derived, so they roll off in days while events and observations
are kept for months; many small Parquet files get compacted into daily ones. `/health` answers "is
this data trustworthy right now?" rather than "is the process alive".

*Done when:* killing a feed, freezing a feed, or filling the disk each produce a visible, correct
response instead of silent bad data.

### B2 — Context: weather and the calendar

A small ingester records hourly weather for NYC (Open-Meteo: temperature, precipitation, snow, wind,
code) into its own Parquet table, and a calendar table marks weekday type, US holidays, and the
school-year season. Both are keyed by hour so any historical query can join them. Nothing uses them
yet; this sprint is about never wishing we had started recording sooner.

*Done when:* every recorded hour has weather and calendar context, and a query can ask "what did the
F do in the rain".

### B3 — Hierarchical calibration

Replace the flat tables with the backoff hierarchy above, with shrinkage, for run time, dwell and
approach. Conditioning on hour-of-week, daypart, weather band, and season. The lookup stays a pure
function of `(segment, time, conditions)` so it runs identically in the poller and in the browser.
Scored against the existing holdout harness at every level, so we can say exactly what each
conditioning dimension bought.

*Done when:* the evaluator shows the hierarchy beating the flat tables, and a table exists of how
much each dimension contributed.

### B4 — Dwell, crowding and the peak

Dwell is where the peak actually shows up: a rush-hour train at Grand Central spends far longer
with its doors open than the same train at 11pm, and on the lettered lines dwell is *modelled*
rather than observed, so errors there propagate straight into every departure. Build a dedicated
dwell model with the station-rooted chain plus two crowding proxies we can genuinely measure —
headway to the train ahead (a long gap means a full platform) and how far the line as a whole is
running behind its own baseline. Feed it back into the departure modelling for the B division.

*Done when:* modelled departures on the lettered lines are measurably closer to the arrivals that
follow them, and dwell varies with the peak the way the real system does.

### B5 — Learning that runs itself

Nightly: rebuild from everything recorded, score the candidate against the incumbent on a held-out
window, and adopt only if it wins. Record every attempt with its numbers, so a regression is
visible rather than mysterious. Detect drift — a schedule change, a long-term slowdown — and say so.

*Done when:* the tables improve on their own overnight, a bad candidate is refused, and `/health`
shows when learning last ran and what it decided.

### B6 — Say what is unusual

Once there is a baseline for "a normal Tuesday at this hour", the deviation from it is a product in
itself: *the L is running 40% longer between stops than usual for this hour*. This is the thing no
one else can show, because no one else is keeping the baseline.

*Done when:* the line-health view compares today to the learned baseline rather than to nothing, and
the map can mark a line as running unusually.

## Order and why

B1 → B2 first and immediately: reliability protects everything, and **context has to be recorded
before it can be learned from** — every hour we wait is an hour of history that can never be
conditioned on weather. B3 and B4 are the modelling core and need weeks of recordings to pay off
fully, but can be built and scored on what exists. B5 makes it self-sustaining. B6 turns the whole
apparatus into something a rider can see.
