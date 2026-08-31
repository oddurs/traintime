# Accuracy sprints — from an actual audit

> **Outcome (31 August 2026).** Sprints J and K are done. Every defect below is closed and each
> one left a check behind: `npm run audit` (live invariants, exits non-zero), `scripts/audit-ui.mjs`
> (interaction crawl on both viewports), an `invariants` block in `/health`, and 15 tests. The
> deployed poller passes with **0 high, 0 medium over 726 trains**, and the production interaction
> crawl reports **0 problems**.
>
> The permanent audit earned its keep within minutes: deploying the leader-clearance rule
> reintroduced backwards stop times — it pushed a train's first arrival later without moving the
> rest of its run — and the production audit caught it before anyone looked at the map. Sprint L
> (a full-day replay, terminal turnarounds, per-service checks, degradation) remains open.


This plan is not a guess about what might be wrong. Every item below came out of an audit run
against the live app and the live feeds on 31 August 2026: an interaction crawl on desktop and
mobile, a data sweep over all 751 tracked trains, and an independent cross-check that decoded the
MTA feeds separately and compared them against what the app displays.

## What the audit already established

Two things are worth stating before the bug list, because they bound the problem.

**The boards are fundamentally right.** Decoding the feeds independently and comparing our arrival
time against the feed's own, for the same trip at the same station, across five stations and 64
rows: median difference **25 s**, p90 57 s, and consistently *earlier* — which is precisely the
MTA's known late bias being corrected. The app is not inventing trains or times.

**The secondary surfaces are clean.** `/accuracy`, `/api-docs` and both embed views load with no
console errors, no failed requests and correct content.

So the problems are specific defects, not a rotten foundation. Here they are.

## The bug inventory

| # | severity | what | evidence |
|---|---|---|---|
| 1 | **high** | **Predicted stop times run backwards.** A later stop shows an earlier arrival than the one before it. | 158 backwards pairs across 751 trains. **Zero of them are in the raw feed** — the feed had the worst pair 90 s apart and we render them 439 s *inverted*. Entirely self-inflicted: `adjustEta` corrects each stop independently, with different segment and horizon buckets, so the corrected series can cross over itself. |
| 2 | **high** | **The Staten Island Railway renders as two different services.** | The realtime feed labels it `SS`; the static GTFS calls it `SI`. Five trains carry `SS`, which matches no known route, so they draw in the grey fallback with no chevron (console: `Image "tt-chevron-SS" could not be loaded`) and cannot be filtered by the SI bullet. A screenshot of Staten Island shows blue `SI` and grey `SS` trains on the same track. |
| 3 | **medium** | **Eight stops the feed references are missing from the network.** `R60, R65, B05, N12, X22, F10, H19, D23`. | Trains bound for them show a raw id — "H19N" — where a station name belongs, and their track geometry falls back to a straight line. |
| 4 | **medium** | **A destination survives a change of station.** | Set a trip from Times Sq to Grand Central, then search Coney Island: the board still says "to Grand Central-42 St" and reports "No trains from here to Grand Central-42 St right now." A dead end that looks like broken data. |
| 5 | **medium** | **Isolating a route does not zoom on a phone.** | `fitBounds` is given 340 px of left padding for the desktop panel; on a 390 px viewport that cannot be satisfied and MapLibre refuses: `Map cannot fit within canvas with the given bounds, padding, and/or offset`. On mobile the panel is a bottom sheet, so the padding is wrong in direction as well as size. |
| 6 | **medium** | **Ghost trains never leave.** | A 7 train has been "dwelling" for 211 minutes with a state unchanged for 3.5 hours. Expiry only removes trains the feed stops mentioning; the MTA keeps publishing this one, so it sits on the map forever, indistinguishable from a real train. |
| 7 | **low** | **A train reported as having arrived in the future.** | One train's `arrivedAt` is ahead of the snapshot clock — a feed timestamp we accept without sanity-checking. |
| 8 | **low** | **A station board can miss a train that is far out.** | Per-train predictions are capped at 12 stops, so a train more than 12 stops away is absent from the board even though the feed knows about it. Harmless at a busy station, wrong at a quiet one. |

Verified **not** bugs, so they do not get "fixed": the save-station star (my first probe read the
attribute before React re-rendered), and the board-vs-feed differences above.

---

## Sprint J — Fix what the audit found

*Goal: every defect above is closed, and each one leaves behind a check that would have caught it.*

Ordered by how visible the damage is:

1. **Monotonic predictions.** After correcting each stop, enforce that the sequence never goes
   backwards: each stop is at least its predecessor plus a floor derived from that segment's
   learned run time. This is a constraint on the output, not a new model, and it cannot make any
   individual estimate worse than the ordering violation it replaces.
2. **Route identity.** Normalise feed route ids to GTFS ones (`SS` → `SI`) at the decode boundary,
   where every consumer benefits. Then make unknown routes *safe* rather than merely unlikely: a
   neutral colour, a real label, a registered chevron, and a counter in `/health` so a new alias
   announces itself instead of appearing as grey trains.
3. **Complete the network.** Find why those eight stops are absent — almost certainly that
   representative trips do not cover every scheduled pattern — and include every stop the schedule
   contains. Assert at build time that the network covers every stop the feeds reference.
4. **Ghost detection.** A train whose state has not advanced for far longer than its line's
   headway is not running. Mark it stale, drop it from boards, and fade it on the map rather than
   presenting it as fact.
5. **Trip scoping.** A destination belongs to the journey, not the session: clear it when the
   origin changes, unless the new origin also serves it.
6. **Mobile framing.** Pad `fitBounds` from the actual panel geometry — bottom inset on a phone,
   left inset on a desktop — and never ask for more padding than the viewport can give.
7. **Clock hygiene.** Reject feed timestamps from the future, and prediction horizons beyond a
   sane bound, at the tracker boundary where they enter.

*Done when:* the data sweep reports zero backwards pairs, zero unknown routes, zero unknown stops
and zero ghosts; the interaction crawl is clean on desktop and mobile; and each has a regression
check.

## Sprint K — Make the audit permanent

*Goal: these checks run by themselves, so the next regression is caught by a machine and not by
you looking at the map.*

- **`npm run audit`** — the interaction crawl and the data sweep as a committed script with a
  non-zero exit on any finding, run on both viewports.
- **A live invariants endpoint.** The data sweep's rules — monotonic predictions, known routes,
  known stops, sane clocks, no ghosts — evaluated by the poller against its own state every
  minute and surfaced in `/health`, so the deployed system reports its own correctness rather than
  waiting to be asked.
- **The cross-check in CI.** Decode the feeds independently and assert that board times sit within
  a sane distance of the feed's own. It is the one test that would catch a wholesale modelling
  mistake, and it needs no fixtures.
- **Fixture replay tests.** Freeze a few recorded ticks — an overnight reroute, a terminal
  turnaround, a shuttle, an SIR run — and assert the tracker's output. Fast, deterministic, and
  they pin the exact behaviours this audit had to discover by hand.

*Done when:* `npm run audit` is green in CI, `/health` carries an invariants block, and the
fixtures fail if any behaviour found in this audit regresses.

## Sprint L — The edges the audit could not reach

*Goal: the cases that are rare enough to hide from a single afternoon's audit.*

- **A full service day.** Replay a recorded 24 hours through the invariants and count violations by
  hour. Overnight reroutes, the 3 am schedule change and the first trains of the morning are where
  the assumptions break, and they are already recorded.
- **Terminal turnarounds.** A train that finishes a run and starts another is two trip ids and one
  physical train; check that it is not drawn twice, and that the new run does not inherit stale state.
- **Every service, deliberately.** GS, FS, H, SIR, the express diamonds and the rush-only variants
  each get a named check, because each one has already produced a bug once.
- **Degradation.** Kill a feed, freeze a feed, cut the network mid-session, and assert the app says
  something true rather than showing stale numbers confidently.

*Done when:* a 24-hour replay reports zero high-severity violations, and each named service has a
passing check.

---

## Order

J first and immediately — these are live defects a user can see today. K next, because without it
J's fixes decay. L last, since it needs J's invariants to measure against.
