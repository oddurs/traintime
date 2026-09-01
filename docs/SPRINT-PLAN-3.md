# Sprint plan — the weaknesses, measured

Every item below came from probing the running system on 1 September 2026, not from a list of
things that sound like good practice. Where I guessed and was wrong, that is recorded too.

## What I checked, and what turned out to be fine

- **Train count.** The deployed poller holds ~890 trains at 00:20, which looked like a leak on a
  nine-hour-old process. It is not: the MTA publishes **854 trip updates** at that moment, 714
  with a vehicle record. Expiry works — a train the feed stops mentioning is dropped after 120 s.
- **Nightly learning.** It runs in production and refuses bad candidates. Last night it adopted:
  **41.1 s against 46.6 s** on 480,339 held-out observations.
- **The basics of accessibility.** `lang` is set, there are four landmarks, reduced motion is
  honoured, and 43 of 44 interactive elements have an accessible name.

---

## Sprint M — Make the measurement loop fast and broad

*The engine is the product, and every accuracy decision in this codebase was made on one window.*

The evaluator takes about **25 minutes** for a 2.3-hour window. That is the reason the terminal
level, the approach fix and the kinematics bounds were each judged on a single evening slice —
and it is why a full 24-hour replay has still never completed. Overnight is the window where the
MTA's own error is three times its daytime figure and half the lines are rerouted, and we have
never scored it.

- Profile the evaluator and cut the run to minutes: the tick decode is repeated per arm, the
  network is re-laid per segment, and nothing is cached between runs of the same window.
- Score **five named windows** — am peak, midday, pm peak, evening, overnight — and keep them as
  the standard set. A change has to be reported across all five or not at all.
- Run the 24-hour replay to completion and publish the by-hour table.
- Make an A/B a first-class thing: two variants, one window, one command, one table.

*Done when:* a full day scores in under an hour, `npm run evaluate` prints the five-window table,
and the accuracy page carries it.

## Sprint T — Test the things that matter most

*Coverage is inverted: the modules with the most consequence have the fewest tests.*

46 tests, concentrated in the tracker, the network and the poller. Untested by name:

| module | what it decides |
|---|---|
| `kinematics` | where every train is drawn — only ever exercised through the 25-minute evaluator |
| `arrivals` | every board a rider reads |
| `invariants` | what "correct" means for the live audit, the replay audit and `/health` |
| `gbm` | evaluates the shipped model; a decode bug would silently skew every prediction |
| `hierarchy` | the shrinkage the timing tables are built on |
| `format`, `alerts`, `urlState` | what the interface says, and what a shared link restores |

- Unit tests for `kinematics` against hand-built paths: braking curves, leader holds, the approach
  fix, the curvature clamp, and the invariant that a train never reverses.
- `arrivals` against fixture states: complexes, destinations, departures at terminals, the
  ordering, and the cap.
- `gbm` against the Python trainer's own output — the same feature vector must produce the same
  number in both languages, which is the one bug that would be invisible everywhere else.

*Done when:* every module in `src/lib` has direct tests, and the kinematics ones catch a
deliberately broken braking curve.

## Sprint A — Accessibility, and knowing when a browser fails

*A live countdown that announces nothing, and a client that reports nothing.*

Measured: **zero live regions** in an application whose entire content is a number that changes
every second — a screen reader user is told once and then never again. One unlabelled input. One
heading-order skip (`h1` straight to `h3`).

And the browser is silent: the poller reports its own health continuously, but if the map throws
for a real user, or a style or font fails to load, nobody ever learns. The interaction crawl only
walks the paths I wrote down.

- A polite live region for the next arrival, updating on a sensible cadence rather than per tick.
- Fix the input label and the heading order; add an accessibility pass to the audit so both stay
  fixed.
- Keyboard: a visible focus path through search → results → board → row, and escape behaviour that
  matches what the sheet does on a phone.
- Client health: catch and report render failures and failed asset loads to the poller, so
  `/health` can say "3 browsers failed to start the map in the last hour".

*Done when:* `npm run audit:a11y` is part of CI, a screen reader reads a changing countdown, and a
thrown error in the browser is visible in `/health`.

## Sprint W — Weight

*A 936 KB chunk, on a phone, on a platform, with no signal.*

Never measured on anything but localhost. MapLibre is most of it and is not going away, but the
first paint does not need the whole map engine, and a rider who opens the app underground needs
the last board more than they need a map they cannot download.

- Measure honestly first: cold load on a throttled connection, time to a usable board, and how
  much of the bundle is needed before the map appears.
- Split the map engine out of the first paint so the board renders while it loads.
- Make the offline case a designed one rather than a fallback: the last board, its true age, and
  an honest statement that it is not live.

*Done when:* a board is readable on a cold, throttled load in under three seconds, and the app is
useful with the network cut.

## Sprint R — The residue

*Small, known, and each one currently invisible to a check.*

- **22 orientation conflicts** in the map layout, where a cycle in the network makes a corridor's
  direction ambiguous, and **8 joints** where two strokes still part by up to 8 m.
- **`--tr-body` and `--tr-caption` are zero**, so the tracking rule cannot catch a body style used
  with the wrong tracking — the check has a blind spot exactly where most of the text is.
- **890 trains at midnight, 309 of them unchanged for ten minutes and only 44 flagged stale.** The
  feed really does publish them, so this is not a bug — but presenting a train the MTA has not
  revised in forty minutes exactly like one revised nine seconds ago is a claim we cannot support.
  Either the staleness bar is too permissive or the map needs a third state between live and gone.

*Done when:* the layout audit reports zero conflicts and no joint over 2 m, the tracking rule has
no blind spot, and a train's confidence is visible rather than implied.

---

## Order

**M first** — everything else is judged by it, and at 25 minutes a run the loop is too slow to
judge anything properly. **T next**, because it protects the engine M measures. **A** and **W**
are the product's obligations to people who are not me on a fast laptop. **R** last: real, small,
and already written down.
