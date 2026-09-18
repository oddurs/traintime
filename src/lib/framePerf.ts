/**
 * What the map costs per frame, measured rather than believed.
 *
 * Three milestones of render work are about to be judged on whether the map "feels" better, and
 * this project has the habit of measuring instead — the retention windows in `docs/STORAGE.md` are
 * defensible because somebody counted the bytes. The same standard should apply here.
 *
 * Two numbers matter, and neither is the frame rate. The frame rate under a headless software
 * rasteriser says more about the rasteriser than about us, and on real hardware it is capped at the
 * display and hides everything until it does not. So this records instead:
 *
 *   - **how long our own frame callback takes**, which is main-thread work we are responsible for
 *     and is independent of the GPU, and
 *   - **how many source uploads we ask MapLibre for**, because a `setData` is a worker round-trip,
 *     a re-parse and a re-tile, and the whole complaint about panning is that we ask for them
 *     during a gesture.
 *
 * Off unless asked for, by `?perf=1` or `window.__ttPerf.enable()`, so it costs a disabled boolean
 * check in the build people actually load — and works in that build, which a `NODE_ENV` guard would
 * not. A measurement you can only take in the dev server is a measurement of the dev server.
 */

interface Counters {
  /** Frames the callback ran to completion, including the ones that returned early. */
  frames: number;
  /** Total and worst time inside our callback, in milliseconds. */
  totalMs: number;
  maxMs: number;
  /** Frames at or over 8 / 16 ms of *our* work — a budget, not a frame time. */
  over8: number;
  over16: number;
  /** Source uploads asked for, by source name. This is the number the gate governs. */
  uploads: Record<string, number>;
  /** Wall time the window covers, so everything above can be stated per second. */
  sinceMs: number;
}

const zero = (): Counters => ({ frames: 0, totalMs: 0, maxMs: 0, over8: 0, over16: 0, uploads: {}, sinceMs: 0 });

let on = false;
let c = zero();
let startedAt = 0;

/** Read in the hot path, so it is a plain boolean rather than a lookup. */
export const perfOn = () => on;

export function frameTook(ms: number): void {
  if (!on) return;
  c.frames++;
  c.totalMs += ms;
  if (ms > c.maxMs) c.maxMs = ms;
  if (ms >= 8) c.over8++;
  if (ms >= 16) c.over16++;
}

/**
 * One source upload. Called at the point of the `setData`, not around it: the cost being counted
 * is not the milliseconds this thread spends handing the data over, it is the pipeline the handover
 * starts on a worker and the re-tile that follows.
 */
export function sourceUploaded(name: string): void {
  if (!on) return;
  c.uploads[name] = (c.uploads[name] ?? 0) + 1;
}

function read(): Counters & { perSecond: Record<string, number>; meanMs: number } {
  const sinceMs = on ? performance.now() - startedAt : 0;
  const s = Math.max(1e-6, sinceMs / 1000);
  const perSecond: Record<string, number> = { frames: c.frames / s };
  for (const [k, v] of Object.entries(c.uploads)) perSecond[k] = v / s;
  return { ...c, sinceMs, perSecond, meanMs: c.frames ? c.totalMs / c.frames : 0 };
}

function reset(): void {
  c = zero();
  startedAt = performance.now();
}

function enable(): void {
  on = true;
  reset();
}

/**
 * Installed on the window so a driver outside the page can start a scenario, run it, and read the
 * counters back — see `scripts/audit-frames.mjs`. Nothing in the app reads this.
 */
export function installFramePerf(): void {
  if (typeof window === "undefined") return;
  const w = window as unknown as { __ttPerf?: unknown; location: Location };
  if (w.__ttPerf) return;
  w.__ttPerf = { enable, reset, read, get on() { return on; } };
  try {
    if (new URLSearchParams(w.location.search).get("perf") === "1") enable();
  } catch {
    /* A page served from a URL we cannot parse is not a reason to fail to draw the map. */
  }
}
