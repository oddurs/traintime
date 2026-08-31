# Product roadmap

The accuracy work made the trains truthful. This plan makes the map *useful* — to someone waiting
on a platform, someone watching the city breathe, and someone who wants to know whether to trust
what they see. Five sprints, each with an exit criterion you can check by opening the site.

Where we start: a dark map, route toggles, a click popup, uncertainty ribbons, replay (local only).
Cold start on the public site is ~5 s of empty map; the panel covers a third of a phone screen;
markers are dots with no heading; nothing is shareable; nothing explains itself.

## Sprint 1 — First impression

*Goal: within three seconds of landing, a stranger understands what they're looking at, and it feels alive.*

- **Progressive load.** Show the basemap and route lines immediately; trains appear as the first
  feed lands (numbered lines within ~2 s). Load the 1 MB residual model *after* first paint, and
  fall back to the tables until it arrives. Split `network.json` so geometry streams first.
- **Heading.** Replace dots with a subtle direction cue (a tapered marker or a leading tick using
  the bearing the kinematics already computes). Uptown vs downtown should be legible at a glance.
- **Motion language.** One visual vocabulary: solid = confirmed at a station, glow = uncertainty,
  amber ring = holding, faded = not yet in service. A two-line legend in the panel that can be
  dismissed for good.
- **Mobile layout.** Panel becomes a bottom sheet with three states (peek / half / full); route
  bullets scroll horizontally in peek. The map is never covered by more than a fifth of the screen.
- **Overview.** Default camera that frames the whole system with Manhattan readable; smooth
  zoom-to-line when a bullet is solo'd (shift-click today → make it a long-press/double-tap too).
- **Respect `prefers-reduced-motion`.** Trains still move; the ribbon and glow don't pulse.

Exit: first trains on screen < 3 s on a mid-range phone over 4G; a first-time visitor can say
which way a train is going and why one is glowing.

## Sprint 2 — Find my train

*Goal: the map answers "when is the next 2 to Brooklyn from where I am" better than the platform sign.*

- **Station search** (name, with the route bullets that serve it) and **nearest stations** via
  geolocation, from a search box that is the first thing on mobile.
- **Station view.** Tapping a station opens an arrivals board: next trains per direction with our
  corrected ETA and ±σ, live, plus where each train physically is (highlighted on the map). This
  is where the accuracy work becomes a feature: "2 min ±20 s, currently leaving Chambers St".
- **Follow a train.** From a popup, "follow" locks the camera to it (with a gentle easing), keeps
  its arrivals board pinned, and un-follows on any pan.
- **Shareable state.** The URL carries view, visible routes, a followed train or a station
  (`#station=A24`, `#train=…`, `#routes=A,C`). Every state of the app is a link.
- **Keyboard.** `/` to search, arrows between results, `Esc` everywhere.

Exit: from a cold load, reach the arrivals board for a named station in two interactions; the
station view's ETAs are the ones the evaluator scores (no second code path).

## Sprint 3 — Trust and transparency

*Goal: every claim on the map says how it knows, and the site publishes how right it is.*

- **Provenance language** in the popup and station board: "confirmed at 14 St 12 s ago",
  "departure estimated (this line doesn't report departures)", "MTA says 4 min; usually 30 s
  early here". Uncertainty is already computed — say it in words, not just a glow.
- **Accuracy page.** A public `/accuracy` built from the evaluator's JSON: ETA error by horizon
  and line versus the MTA's own predictions, calibration, position error, updated by the learn
  job. Nobody else publishes this; it is the honest pitch for the whole project.
- **Service alerts.** Consume the MTA alerts feed: reroute and suspension banners per line, and a
  dashed treatment on affected segments. Trains running off-pattern (the feed tells us via
  `actual_track` and skipped stops) get an "express run / rerouted" tag.
- **Freshness per line** in the panel (the numbered feed refreshes every 5 s, lettered every
  15 s — show it), and a clear degraded state when a feed is down.
- **"Why is it holding?"** — the popup names the leader train or the slipped ETA.

Exit: an outsider can read, from the site alone, how the positions are made and how accurate they
were yesterday.

## Sprint 4 — Time

*Goal: the map has a past, on the public site.*

Prerequisite: **host the poller** (a small VPS or Fly.io machine running `npm run poller`, with
`POLLER_URL` pointed at it). Everything below needs history the browser can't have; this is the
single most valuable infrastructure decision left. It also lets the learn/train jobs run nightly so
the public predictions keep improving without a release.

- **Timeline scrubber.** Replace the date/duration form with a scrubber under the map: drag
  through the last 24 h, play at 1–120×, with event density (arrivals) drawn on the bar so rush
  hour is visible before you play it.
- **Line health over time.** Per line: headway and delay for the last 24 h as small charts in the
  panel, from the recorded events. "The L is running 8-minute headways, 2 minutes worse than
  usual."
- **Timelapse export.** A shareable 30-second video of any hour (rendered client-side from replay).
- **Yesterday vs today** for a station board: how the same train usually does.

Exit: a visitor to the public site can watch this morning's rush hour and see which lines were
struggling, without anything running on their laptop.

## Sprint 5 — Platform and polish

*Goal: traintime works everywhere it's opened and can live inside other things.*

- **PWA**: installable, offline shell, screen wake-lock while following a train, proper icons and
  share preview images (a rendered map thumbnail per shared state).
- **Embeds**: `/embed?station=A24` and `/embed?route=L` — a minimal iframe-able view for blogs,
  lobbies, and dashboards.
- **API docs** at `/api` with live examples for `/state`, `/stream`, `/replay`, and a typed
  client package (`@traintime/client`) that is the same code the site uses.
- **Performance budget**: 60 fps on a three-year-old phone with all lines on; update the train
  source at 30 Hz and interpolate in the shader if needed; measure with a Lighthouse job in CI.
- **Accessibility pass**: focus order, screen-reader labels for the station board, sufficient
  contrast on every route color (the N/Q/R/W yellow needs a dark outline on text), colorblind-safe
  route disambiguation via letters everywhere.

Exit: Lighthouse ≥ 90 across the board on mobile; an embed running on a page that isn't ours.

## Measurement

Product changes get judged like accuracy changes did — by something checkable:

- **Time to first train** (synthetic, in CI via the headless harness already used for screenshots).
- **Interactions to arrivals board** (design constraint, verified by the harness).
- **Accuracy page numbers** (from the evaluator, automatically).
- Usage, if wanted, via a self-hosted, cookie-less counter — a decision for the owner, not a
  default. The site works fully without it.

## Suggested order and why

1 → 2 → 3 are pure front-end and can ship to Pages immediately; each is a week of focused work.
Sprint 4 is the one that needs money (a few dollars a month) and a decision; do it once the
station view exists, so history has something to show up in. Sprint 5 is continuous polish that
should start as soon as Sprint 1 lands.
