# What the MTA subway feeds actually mean

Findings from recording every feed at its own cadence and replaying the raw ticks. None of this is
in the MTA's documentation; all of it changes how positions must be derived. Numbers are from the
first evening of recording (Aug 30, 2026); re-verify with `scripts/evaluate.ts` if the feeds change.

## Cadence

| feed | regenerates every |
|---|---|
| `gtfs` (1–7, GS) | ~5 s |
| `gtfs-l` | 5–10 s |
| `gtfs-ace`, `gtfs-bdfm`, `gtfs-g`, `gtfs-jz`, `gtfs-nqrw`, `gtfs-si` | ~15 s |

No API key is required and the endpoints send `access-control-allow-origin: *`, so a browser can
fetch them directly.

## The NYCT extension is populated

Every stop time update carries `actual_track` (e.g. `A1`/`A3` local, `A2`/`A4` express on 8th Ave)
and every trip carries `train_id` (`1A 1824+ FAR/207`: origin time to the half-minute, origin and
destination) and `is_assigned`. `actual_track` resolves the local/express ambiguity when a train is
first seen mid-segment.

## Two kinds of vehicle record

**Transit feeds — numbered lines and the L.** The vehicle record behaves as documented:

- `STOPPED_AT X` with `timestamp` = arrival at X, constant for the whole dwell.
- `IN_TRANSIT_TO Y` / `INCOMING_AT Y` with the timestamp advancing every ~10 s while moving. The
  first in-transit timestamp is within one refresh of the departure. `INCOMING_AT` precedes
  arrival by ~11–18 s (learnable per station). This is the **only observation of a train between
  two platforms the feeds ever produce** — everything else about an intermediate position is
  inference — and it is plentiful where it appears: 90–97% of arrivals on the 1, 2, 4, 6 and 7
  carry one, against ~1% on the lettered lines, 77,124 in all against 193,952 arrivals. The
  approach it marks takes a median 13 s (p16 5 s, p84 23 s across 376 stops) and accounts for
  **36% of the whole run**, cruise being a median 31 s and approach 18 s.
- The trip update's "arrival" time for the stop the train is *currently at* is its **expected
  departure**, not its arrival — the feed does not model dwell separately. Our observed arrivals
  are ~32 s earlier than that prediction with a spread of only ~4 s.

**Heartbeat feeds — the lettered lines.** The vehicle record stays `STOPPED_AT X` from arrival at
X until arrival at Y. While it is stopped the timestamp keeps advancing, and the trip update's
"arrival" for X advances with it. The trip update drops X some ~40 s after the last push.

- **Arrivals are exact** (first timestamp of a new `STOPPED_AT`).
- **Departures are observable after all — the heartbeat freeze marks them.** This corrects an
  earlier reading in this document, which held that neither the freeze nor the trip-update drop
  located the departure and modelled it as arrival + typical dwell instead.

  The advance is a metronome, not a drift: measured over 28,144 advances on `gtfs-ace`, the gap
  between them is **16 s at the 50th, 90th, 97th and 99th percentiles alike**. It stops dead when
  the train pulls out. So the value it froze at is a real feed timestamp for a real departure, and
  a silence longer than 45 s (the cadence plus feed latency, with margin) is an unambiguous
  "gone".

  Tested the only way that settles it: a better departure estimate must make the run times it
  implies more *consistent*, since the true run time over a given stretch of track barely varies.
  Across 23,393 completed runs over 850 stretches, the spread of implied run time falls from
  **30 s to 17 s**. It is now the departure the tracker uses and records, which is also what
  finally gives the lettered lines observed dwell.

  **The freeze is the signal, not the moment.** That spread test cannot see a constant error —
  subtracting the same number from every departure shifts every implied run time equally and
  leaves the spread untouched — and the beat does run on past the departure, as the first version
  of this document said. Three independent measurements put it at about **25 s**: lettered-line
  dwell is 24 s longer than numbered-line dwell *at the same station* across the 20 complexes
  where both stop, 27 s longer overall, and lettered-line run times sit 32 s shorter relative to
  the schedule. Uncorrected it took the global dwell prior from 50 s to 62 s and dragged every
  marker back — 170 m from the platform to 248 m — while the ETAs improved, which is how a
  correction that is right in one place and wrong in another hides.

  The correction applies only to feeds that *never* report a moving train. Two are hybrids: the L
  advances its timestamp 4,210 times while stopped and 2,955 times while moving, and the Staten
  Island Railway 895 against 202. Their departures are directly observed and are not late;
  correcting them drove the L's dwell to the floor.
- The MTA's ETA for the next stop drifts later while it is blind, which is where most of its
  −18 to −25 s arrival bias at 1–5 minute horizons comes from. That bias is stable and learnable.
- `IN_TRANSIT_TO` does appear on these feeds, but its timestamp is a *predicted* arrival (it can
  be in the future), not a position update.

## Trip update vs vehicle disagreement

On heartbeat feeds the trip update drops a stop from its list while the vehicle still says
`STOPPED_AT` it; occasionally the list still contains the *previous* stop after the vehicle has
arrived at the next. The vehicle record is the authority on "where is the train now"; the trip
update is the authority on predicted times.

## Data latency

From the feed's own event timestamp to our fetch: median 9 s, p90 ~20 s (the feed generation
interval plus our polling offset). Event timestamps are the feed's, so learned run times and
dwells are not affected by polling latency; only how quickly the map reacts is.
