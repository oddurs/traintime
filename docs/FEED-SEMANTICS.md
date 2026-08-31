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
  arrival by ~11–18 s (learnable per station).
- The trip update's "arrival" time for the stop the train is *currently at* is its **expected
  departure**, not its arrival — the feed does not model dwell separately. Our observed arrivals
  are ~32 s earlier than that prediction with a spread of only ~4 s.

**Heartbeat feeds — the lettered lines.** The vehicle record stays `STOPPED_AT X` from arrival at
X until arrival at Y. While it is stopped, the timestamp keeps advancing (~every 10–25 s) and the
trip update's "arrival" for X advances with it: this is the MTA's own *expected departure* being
pushed forward, not a presence signal. When the train leaves, the timestamp keeps being pushed
for a while (median: until 26 s before the next arrival, 0.41× the scheduled run) and then
freezes; the trip update drops X ~40 s after the last push. Consequences:

- **Arrivals are exact** (first timestamp of a new `STOPPED_AT`).
- **Departures are unobservable.** Neither the heartbeat freeze nor the trip-update drop marks
  the departure. traintime models departure as arrival + typical dwell (learned from the transit
  feeds) and confirms "definitely gone" from the trip update.
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
