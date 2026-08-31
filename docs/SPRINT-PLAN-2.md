# Sprint plan — accuracy, craft, the commuter, and better predictions

Five sprints. Each names what "done" means as something checkable, because that is the only way
the previous rounds stayed honest.

---

## Sprint E — Lines that never hide each other

*Goal: no stretch of track where a service is invisible because another is drawn on top of it.*

What is still wrong, and why:

1. **Same-colour services are deliberately coincident.** Lanes are assigned per trunk colour, so
   the 4, 5 and 6 share one green line — right for the system map, wrong the moment someone
   filters down to "just the 5 and the 6" and sees one line for two services.
   *Fix:* make lane assignment adaptive. When everything is shown, lanes are per colour (the trunk
   reads as one line, as it should). When a subset is shown, lanes are per visible route, so every
   service the viewer asked for is separately visible.
2. **Corridor detection has thresholds, and thresholds miss things.** Cells are 35 m, bearings must
   agree within 25°, and a route must run alongside for 60% of a segment. Stretches that fail any
   of those are drawn on top of each other.
   *Fix:* audit every pair of segments that are geometrically close but not in a shared corridor,
   and report them. Tune from the audit rather than by eye, and keep the audit as a check.
3. **Crossings are flat.** Where two lines cross, one simply covers the other with no indication of
   which passes over.
   *Fix:* draw each line's casing immediately beneath its own stroke rather than as one layer under
   everything, so a crossing shows a clean break in the line beneath — the way a drawn map does it.
4. **6% of moving trains are drawn between stops their route does not serve** in replay, against 0%
   live. Something in the replay path — probably warm-up before history exists — is placing trains
   on borrowed geometry.
   *Fix:* find it, fix it, and keep the evaluator's check.

*Done when:* the close-but-not-shared audit reports nothing above a set threshold, filtering to any
two services shows two lines, and the evaluator reports under 1% of trains off their own route.

---

## Sprint F — Craft: typography and space

*Goal: it should feel like an app Apple would ship, not a web page with a dark theme.*

The type scale and materials are in place; what is missing is discipline in the spacing and the
small conventions that make an interface feel resolved.

- **An 8-point spacing grid**, applied everywhere, replacing the current assortment of 5s, 6s, 7s
  and 9s. Every gap, pad and inset a multiple of 4, mostly 8.
- **Optical typography**: tighter tracking as type gets larger, looser as it gets smaller; line
  heights set from the grid; numerals always tabular; text that never reflows as a countdown ticks.
- **Inset grouped lists**, the way iOS Settings does them: rows inside a rounded container, hairline
  separators that stop short of the container edge, the whole group titled above rather than boxed.
- **Motion with intent**: one easing curve, one duration scale; the sheet, the camera and the
  disclosure all move the same way, and none of them move at all under reduced motion.
- **States that exist**: pressed, focused, disabled and loading all designed rather than defaulted,
  including a real skeleton while the first feed lands.
- **Optical alignment** of the roundels against text baselines, which is what makes a bullet list
  look typeset rather than assembled.

*Done when:* every spacing value in the stylesheet is on the grid, the contrast audit still passes,
and a screenshot at phone and desktop size reads as a native app.

---

## Sprint G — The commuter's app

*Goal: someone who takes the same train every day should get their answer before they finish
unlocking their phone.*

- **Saved places.** Home and work, or simply pinned stations, remembered on the device. The board
  for the relevant one opens first, chosen by time of day and proximity.
- **A direction that is remembered.** Nobody wants both directions when they only ever go one way
  in the morning; remember which way they looked last at each station.
- **Walk time.** "6 minutes away — you can make the 08:14" is the actual question a commuter is
  asking. With location, compute the walking time to the platform and mark which trains are
  catchable.
- **A commute, not a station.** Pin an origin and destination; show the next few departures that
  serve it, with the arrival time at the far end, using our own run-time model for the whole trip.

*Done when:* opening the app cold, with location granted, shows the next catchable train from the
nearest saved station without any interaction.

---

## Sprint H — Trust on the platform

*Goal: the app is honest and useful exactly when the system is not behaving.*

- **Service changes that matter to you**, not all 200 of them: alerts filtered to the saved
  stations and lines, surfaced above the board when they affect the trip being shown.
- **"Is something wrong?"** Compare the line to its own learned baseline and say so plainly: *trains
  on the L are coming every 9 minutes; usually 5 at this hour*.
- **Offline that works.** The last board kept on the device with its age shown honestly, so a
  phone that loses signal on the stairs still shows something true rather than nothing.
- **Countdowns that degrade gracefully.** When data is stale, the number stops being a countdown
  and becomes "as of 2 minutes ago" — never a confident number built on old data.

*Done when:* with the network cut, the app shows the last board with its true age; and a line
running unusually is labelled as such from the learned baseline.

---

## Sprint I — Predictions worth the trust

*Goal: use what we uniquely have — the whole line's state, and months of our own history.*

- **The train ahead.** A train cannot arrive before the one in front of it leaves. Propagate the
  leader's predicted departure into the follower's arrival, which is the single largest source of
  error at the 2–5 minute horizon.
- **Per-trip bias.** A train that has been running 40 s behind its predictions all morning will
  very likely be 40 s behind at the next stop too. Estimate a per-trip offset online and apply it,
  decaying as it ages.
- **The final approach.** `INCOMING_AT → STOPPED_AT` is the one intra-segment observation the feed
  gives us; model it per platform and use it to sharpen the last thirty seconds, which is when
  people are looking.
- **Terminal departures.** Trains that have not started are placed by schedule alone; the history
  of how late each terminal actually dispatches is learnable and would fix the worst horizon.
- **Honest σ.** Calibration is at 87% for the nearest horizon but 57% at 5–15 minutes. Widen the
  far horizons until stated uncertainty matches observed error at every horizon.

*Done when:* the evaluator shows lower MAE at the 2–5 and 5–15 minute horizons, and 1σ coverage
within a few points of 68% at every horizon rather than only the nearest.

---

## Order

E first — accuracy is the foundation and the visible complaint. F next, because the commuter
sprints build on its components. G and H together are the product. I last, because it is measured
against a harness that must not be changing underneath it at the same time.
