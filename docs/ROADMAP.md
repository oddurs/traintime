# Accuracy roadmap — status

The original plan (below) was executed in one pass. What was built, what the numbers say, and what
is still open.

## What exists

| sprint | delivered |
|---|---|
| 1 Instrument | Poller at feed cadence → raw ticks, station events, ETA revisions in Parquet (`data/rec/`). `scripts/evaluate.ts` replays any window through the real tracker and scores it against observed arrivals. `scripts/rebuild-events.ts` re-derives history after tracker changes. |
| 2 Kinematics | `src/lib/kinematics.ts`: position + velocity per train, accel/brake limits, a pacing controller that meets the ETA, a braking curve into the platform, holds when the ETA slips, train-following (same segment or occupied platform). Zero reversals and zero jumps over 460 k replayed steps. |
| 3 Learned timing | `scripts/learn-timing.ts` → run times, arrival-to-arrival, dwell, approach, ETA residuals with hierarchical backoff (segment → route → all, by horizon) and calibrated 1σ, track→predecessor counts. `scripts/train_eta_model.py` → gradient-boosted residual model exported as trees and evaluated in Node (`src/lib/gbm.ts`); it deploys itself only if it beats the tables on a time-based holdout. |
| 4 Line dynamics + uncertainty | Leader detection and following in the tracker/kinematics; per-stop σ from the residual tables; an uncertainty ribbon on the map (±1σ of arrival time along the track); calibration reported by the evaluator. |
| 5 Beyond the feed | Multi-stop adjusted predictions with σ in the popup; replay of any recorded window at 1–60× from the UI; the poller's JSON/SSE API (`/state`, `/stream`, `/replay`, `/timing`, `/recordings`); the whole pipeline also runs in the browser for the static deployment. |

## Numbers (first 40 minutes of recording, replayed)

ETA at the next stop, scored against observed arrivals:

| horizon | MTA MAE | MTA bias | ours (tables) MAE | ours bias | 1σ coverage |
|---|---|---|---|---|---|
| <45 s | 30.0 s | −32 s | 6.5 s | 0 s | 86 % |
| 45–120 s | 32.7 s | −18 s | 25.5 s | −3 s | 73 % |
| 2–5 min | 41.7 s | −25 s | 29.6 s | −2 s | 71 % |
| 5–15 min | 84.2 s | −58 s | 46.0 s | −5 s | 74 % |

The tables above are scored in-sample. On a time-based holdout (last quarter of observations) the
boosted model scores 34.5 s MAE vs 37.2 s for the MTA and 38.6 s for the tables alone — with 40
minutes of data the tables overfit and the model is the safer deployment. Both improve with data;
rerun `npm run learn && npm run train-model` after a day of recording.

Position at the moment of a real arrival: median 225 m short of the platform, p90 491 m (from
~440 m before the feed semantics were understood). The remaining error is almost entirely ETA
error (≈ 25 s × ≈ 9 m/s); it will track ETA improvements.

## Open

- **Lettered-line departures are modelled, not observed.** Arrival + learned dwell is the best
  available; a better prior could come from the MTA's own expected-departure pushes (the last
  value before the freeze is a lower bound on the departure). Not yet exploited.
- **More data.** Everything learned is from one evening. Hour-of-day and weekday tables and the
  model's `hour`/`dow` features only become active with days of recordings.
- **Cold placements** (a train first seen mid-segment, or a predecessor guessed wrong) are ~2 % of
  segment entries; the track→predecessor table shrinks this as it fills.
- Delay propagation through a line is implicit (the MTA re-predicts, we re-adjust); an explicit
  model of leader delay → follower ETA is the next modelling step.

---

# Original plan

(kept for context)

Goal: place every train as close to where it really is as the public data allows, and move it the
way a real train moves — and be able to *prove* it with numbers rather than by eyeballing the map.

## The honest framing

There is no ground truth for where a train is between stations. What we can observe exactly is
**station events** — arrivals and, on some feeds, departures — with the MTA's own timestamps. So
accuracy decomposes into **timing** (predicting when the train reaches the next station; where more
data and ML pay off) and **motion** (moving like a train between those times; physics and control,
judged by plausibility). Everything is evaluated by replaying recorded days through the simulator.

## Architecture

```
MTA feeds ──(poll at feed cadence, 5–15 s)──▶ poller/recorder ──▶ Parquet (ticks, events, ETA observations)
                                                   │
                                                   ▼
                                       tracker (one instance, full history)
                                                   │
                                     SSE stream of train states (every feed tick)
                                                   ▼
                                       Next.js client: kinematics + rendering
```

Raw ticks are canonical; events are derived. DuckDB in-process for analysis; Python only for
training; models exported as plain JSON trees.
