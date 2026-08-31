# Contributing

Thanks for taking an interest. traintime is small and opinionated; the best contributions make
the trains more truthful, measurably.

## Setup

```
npm install
npm run build:network      # static GTFS → public/data/network.json (once, and after MTA schedule changes)
npm run dev                # web on :7117 + poller on :7118
```

Python is only needed to train the residual model: `uv venv .venv && uv pip install --python .venv/bin/python scikit-learn duckdb pandas pyarrow`.

## Ground rules

- **Measure before and after.** Anything that touches `src/lib/tracker.ts`, `src/lib/kinematics.ts`
  or `src/lib/timing.ts` should come with `npm run evaluate` output from a recorded window, before
  and after. The evaluator is the arbiter; the map is not.
- **Raw ticks are canonical.** Events and ETA observations are derived; if you change how they are
  derived, run `npm run rebuild-events` so history reflects the new rules.
- **Keep the browser build working.** The static site (`npm run build:pages`) runs the same
  tracker in the browser; `src/lib` must stay free of Node-only imports.
- `npm run typecheck && npm run lint` must pass. CI runs both plus the static build.

## Where things live

| path | what |
|---|---|
| `scripts/build-network.ts` | static GTFS → track geometry, predecessor graph, scheduled run times |
| `services/poller/` | feed polling, Parquet recording, HTTP/SSE server, replay |
| `src/lib/tracker.ts` | feed ticks → station events, ETA observations, per-train state |
| `src/lib/kinematics.ts` | physical motion model + controller (position, speed, holds, following) |
| `src/lib/timing.ts` | learned run/dwell/approach tables, ETA residuals, optional GBM |
| `scripts/evaluate.ts` | replay + metrics against observed station events |
| `scripts/learn-timing.ts` | events → `data/timing.json` |
| `scripts/train_eta_model.py` | residual model → `data/eta-model.json` |
| `docs/` | roadmap and findings about the feeds |

## Reporting feed weirdness

The MTA feeds have undocumented behaviours (see `docs/FEED-SEMANTICS.md`). If you find another,
please include a tick-by-tick dump of the vehicle record and trip update for one train — that is
what settles it.
