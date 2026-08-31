# Sprint plan — design, data, detail, mobile

Four sprints. Each one names what "done" means in a way that can be checked by opening the site or
running a command, because the previous rounds only stayed honest by being measurable.

---

## Sprint A — The look: Vignelli's system in Apple's dark

*Goal: it should feel like the subway system designed the app, and like the app belongs on a modern
phone. Not a pastiche of either.*

Two design languages, and what each one contributes:

**From the 1970 NYCTA Graphics Standards Manual** (Vignelli/Noorda) — the parts that are *rules*,
not decoration: Helvetica, medium weight, tight tracking, sentence case. Information ordered by
importance with nothing competing: station name, then services, then direction, then times. Route
bullets as true circles with the numeral optically centred at a fixed ratio of the diameter, and
**diamonds for express services** — the manual's own distinction, which the app currently ignores.
No rules, no boxes, no ornament: hierarchy comes from size, weight and space alone. Colour means a
line and nothing else, so it must never be spent on decoration.

**From Apple's dark mode** — the parts that make a dark interface readable rather than merely dark:
near-black grounds with genuinely layered elevation instead of borders; translucent material over
the map so context shows through; large-title → headline → body → caption hierarchy with generous
line height; continuous corner radii; restrained accents; 44 pt touch targets; and colour that
stays legible against a dark ground (the MTA's yellow and cyan need care here).

Work:

1. **Type system.** A Helvetica-first stack (`"Helvetica Neue", Helvetica, Inter, system-ui, Arial`)
   with a real scale — large title 28/34, title 20/25, headline 15/20, body 13/18, caption 11/14,
   plus tabular numerals for every time. Replace the current ad-hoc 10–16 px sizes.
2. **Elevation, not borders.** Three surface levels (ground, panel, card) distinguished by
   luminance and blur. Delete most `1px solid` rules; keep hairlines only where two scrolling
   regions meet.
3. **Route bullets, properly.** Circle for local, **diamond for express**, letter at the manual's
   ratio, Helvetica Medium, optically centred. One component, used everywhere including inside
   alert text.
4. **The countdown clock.** Rebuild the arrivals board around the platform-sign hierarchy: big
   tabular minutes on the right, bullet and destination on the left, everything else demoted to a
   caption line. This is the screen a commuter actually reads.
5. **Colour discipline.** Route colours from the GTFS, never re-used for UI meaning; one neutral
   accent for selection; amber reserved for "held"; red reserved for "delay".
6. **Map palette.** Retune the basemap and route-line weights so the city recedes and the lines
   read like the system map, with stations as hairline ticks rather than competing dots.

Done when: a screenshot of the arrivals board is recognisably in the MTA's visual tradition, the
type scale is applied everywhere (no stray font sizes), express services show diamonds, and the
contrast audit still passes with zero failures.

---

## Sprint B — The poller: data worth trusting, all year

*Goal: it runs for a year without me, and the data it produces gets better rather than staler.*

Today the poller is a good recorder with hand-cranked learning and a schedule frozen at whatever
`gtfs_subway.zip` was cached when I built it. Year-round quality means all three of those change.

1. **Survive everything.** Per-feed exponential backoff with jitter, a circuit breaker that keeps
   one sick feed from starving the others, and stall detection (a feed whose header timestamp stops
   advancing is *worse* than one that 404s, because it looks fine). Surface all of it in `/health`
   so the failure is visible rather than silent.
2. **Follow the schedule.** The MTA republishes the static GTFS regularly; a stale `network.json`
   means wrong track geometry and missing stations. Add a weekly job that fetches the zip, compares
   `feed_version`, rebuilds the network, and **serves it from the poller** so clients pick up new
   geometry without a site redeploy — with the built-in copy as the fallback.
3. **Learn on its own.** A nightly job inside the poller: rebuild the timing tables from recorded
   events, retrain the residual model, and adopt each only if it beats the incumbent on a
   time-based holdout. Never regress silently; record every attempt.
4. **Bounded, compacted storage.** Raw ticks are the bulk and the least reusable once events are
   derived: keep a rolling window of them, keep events and ETA observations far longer, and compact
   the many small Parquet files into daily ones. Report disk usage and prune before it hurts.
5. **Correct across the year.** Hour-of-day and weekday tables must be built in America/New_York,
   including across both DST transitions. Verify with a targeted test rather than hoping.
6. **Observability.** `/health` answers "is this data trustworthy right now?" — feed freshness per
   feed, events per minute, disk, last learn attempt and its outcome, uptime.

Done when: killing a feed, filling a disk, or changing the schedule each produce a visible, correct
response rather than silent bad data — and the timing tables improve on their own overnight.

---

## Sprint C — The lines: shared track, express services, and honest motion

*Goal: the map tells the truth about a system where four services share one tunnel and half of them
run express.*

1. **Shared trackage.** Lexington Avenue carries the 4, 5 and 6 over the same geometry, so today
   they are drawn exactly on top of each other and only one colour survives. Compute, per track
   segment, which routes use it, and offset each route's line perpendicular to the track so
   corridors show every colour side by side — the way the system map does. This is the single
   biggest visual untruth in the app.
2. **Express and local.** Diamond bullets for express services, and the express/local distinction
   surfaced where it matters: in the station board ("express — skips 5 stops"), and on the map by
   drawing express services on the express track of a shared corridor. The feed's `actual_track`
   already tells us which track a train is on; we currently only use it for a hint.
3. **Smooth heading.** The chevron currently takes its bearing from whichever polyline segment the
   train is on, so it snaps at every vertex. Replace it with a bearing sampled over a lookahead
   window along the path (behind and ahead of the train) and low-pass filtered over time, so the
   arrow sweeps through curves the way the train does.
4. **Bug hunt, with evidence.** Systematically: trains that appear twice because a trip shows up in
   two feeds; shuttles (GS, FS, H) and the Staten Island Railway; trains stacked at terminals;
   ghost trains that never clear; the express route ids (6X, 7X, FX) inheriting their parent's
   colour; and any train whose drawn position leaves its own line. Each one gets a check in the
   evaluator so it cannot come back.

Done when: Lexington Avenue shows three colours, express services carry diamonds and sit on express
track, the chevron sweeps smoothly through curves, and the evaluator reports zero off-line
positions and zero duplicate trains.

---

## Sprint D — Mobile: built for the platform, not the desk

*Goal: a commuter standing on a platform gets their answer in one glance, one-handed, possibly
underground.*

1. **Location first.** With permission, open directly on the nearest station's board — the single
   most likely thing a person on a platform wants. A persistent "nearby" view that follows them as
   they walk, and re-sorts as they move between stations.
2. **One-handed.** Everything reachable in the bottom third: search, the nearby switch, and the
   sheet controls. Nothing important in the top corners. 44 pt minimum targets, verified rather
   than assumed.
3. **Glanceable.** The peek state of the sheet shows the answer — the next two trains and their
   minutes — before any interaction, in the largest type on the screen.
4. **Underground.** The train that matters is the one arriving in two minutes, and that is exactly
   when signal disappears. Cache the last board with its age shown honestly ("as of 40 s ago"),
   and recover gracefully when the connection returns.
5. **Accessibility for real.** VoiceOver labels that read like a person would say them ("N train to
   Astoria, 4 minutes, give or take 20 seconds"), Dynamic Type support via rem-based sizing,
   reduced-motion and high-contrast paths, and a keyboard-complete interface.
6. **Battery and heat.** Throttle the render loop when the tab is hidden or the sheet covers the
   map, drop the frame budget on low-end devices, and keep a wake lock only while following a train.

Done when: from a cold load on a phone with location granted, the next train at the nearest station
is readable without touching anything; every interactive target is at least 44 pt; VoiceOver reads
the board sensibly; and the page holds 60 fps on a mid-range phone.

---

## How these interact

Sprint A changes the surface, so C's diamonds and offsets should land on top of A's component work
rather than be rebuilt. B is independent and can run first or last, but it needs a deploy to
Railway to matter. D depends on A's type scale and touch targets. Order: **A → C → D → B**, with B's
robustness work pulled forward if the hosted poller shows any instability while the rest is built.
