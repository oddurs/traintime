import type { GbmModel, ResidualStat, Stat, TimingTables } from "./types";
import { gbmCode, gbmPredict } from "./gbm";
import { NetworkIndex, parentOf } from "./network";

/** Horizon buckets (seconds until predicted arrival) used by the residual tables. */
export const HORIZONS = [45, 120, 300, 900];
export function horizonBucket(h: number): string {
  for (let i = 0; i < HORIZONS.length; i++) if (h < HORIZONS[i]) return `h${i}`;
  return `h${HORIZONS.length}`;
}

export interface EtaContext {
  raw: number;
  now: number;
  route: string;
  prev?: string;
  next: string;
  departedAt?: number;
  hour: number;
  dow: number;
}

const MIN_SAMPLES = 8;
const DEFAULT_DWELL = 35;
const DEFAULT_APPROACH = 40;
/** Fallback uncertainty when nothing is learned: 20 s floor growing with horizon. */
const defaultSigma = (h: number) => 20 + 0.15 * Math.max(0, h);

/**
 * Everything we know about how long things take, with graceful fallbacks:
 * learned tables → schedule → geometry. Optionally a boosted model on top of the tables.
 */
export class Timing {
  constructor(
    private readonly net: NetworkIndex,
    public tables: TimingTables | null = null,
    public model: GbmModel | null = null,
  ) {}

  get isLearned(): boolean {
    return !!this.tables;
  }

  private stat(table: Record<string, Stat> | undefined, key: string): Stat | undefined {
    const s = table?.[key];
    return s && s.n >= MIN_SAMPLES ? s : undefined;
  }

  private residual(prev: string | undefined, next: string, route: string, bucket: string): ResidualStat | undefined {
    const r = this.tables?.residual;
    if (!r) return undefined;
    const keys = [prev ? `seg:${prev}>${next}|${bucket}` : "", `route:${route}|${bucket}`, `all|${bucket}`];
    for (const k of keys) {
      const s = k ? r[k] : undefined;
      if (s && s.n >= MIN_SAMPLES) return s;
    }
    return undefined;
  }

  /** Typical dwell where a station never reports departures. */
  get dwellPrior(): number {
    return this.tables?.dwellGlobal ?? DEFAULT_DWELL;
  }

  /**
   * Typical run time (departure → arrival) from prev to next in seconds:
   * observed run → observed arrival-to-arrival minus dwell → schedule minus dwell → geometry.
   */
  runTime(prev: string, next: string, hour?: number): number {
    const key = `${prev}>${next}`;
    const byHour = hour !== undefined ? this.stat(this.tables?.runTimeHour, `${key}@${hour}`) : undefined;
    const s = byHour ?? this.stat(this.tables?.runTime, key);
    if (s) return s.p50;
    const a2a = this.stat(this.tables?.a2a, key);
    if (a2a) return Math.max(20, a2a.p50 - this.dwellPrior);
    const sched = this.net.scheduledRun(prev, next);
    if (sched && sched > 0) return Math.max(20, sched - this.dwellPrior);
    const m = this.net.hop(prev, next);
    return Number.isFinite(m) ? 20 + m / 12 : 90;
  }

  dwell(stop: string, hour?: number): number {
    const byHour = hour !== undefined ? this.stat(this.tables?.dwellHour, `${stop}@${hour}`) : undefined;
    return (byHour ?? this.stat(this.tables?.dwell, stop))?.p50 ?? this.dwellPrior;
  }

  approach(stop: string): number {
    return this.stat(this.tables?.approach, stop)?.p50 ?? DEFAULT_APPROACH;
  }

  /** Adjusted arrival time and calibrated 1σ for the MTA's raw prediction. */
  adjustEta(c: EtaContext): { eta: number; sigma: number } {
    const horizon = c.raw - c.now;
    const bucket = horizonBucket(horizon);
    const res = this.residual(c.prev, c.next, c.route, bucket);
    let delta = res?.median ?? 0;
    const sigma = res?.p68 ?? defaultSigma(horizon);

    if (this.model && this.tables) {
      const seg = c.prev ? `${c.prev}>${c.next}` : undefined;
      const rt = c.prev ? this.runTime(c.prev, c.next, c.hour) : NaN;
      const elapsed = c.departedAt !== undefined ? c.now - c.departedAt : NaN;
      const feats: Record<string, number> = {
        horizon,
        hour: c.hour,
        dow: c.dow,
        route: gbmCode(this.model, "route", c.route),
        segment: gbmCode(this.model, "segment", seg),
        direction: gbmCode(this.model, "direction", c.next.slice(-1)),
        table_median: res?.median ?? NaN,
        table_sigma: res?.p68 ?? NaN,
        run_p50: rt,
        elapsed,
        elapsed_frac: Number.isFinite(rt) && Number.isFinite(elapsed) ? elapsed / rt : NaN,
      };
      const x = this.model.features.map((f) => feats[f] ?? NaN);
      delta = gbmPredict(this.model, x);
    }
    // Never predict an arrival in the past by adjustment alone.
    const eta = Math.max(c.raw + delta, c.now);
    return { eta, sigma: Math.max(8, sigma) };
  }

  /**
   * Which stop did a train come from, when we have no history? Learned track→predecessor
   * counts first, then a hop-length heuristic against the train's own upcoming stops.
   */
  inferPrev(route: string, next: string, track: string | undefined, upcoming: string[]): string | undefined {
    const cands = this.net.prevCandidates(route, next);
    if (cands.length === 0) return undefined;
    if (cands.length === 1) return cands[0];
    if (track) {
      const counts = this.tables?.prevByTrack[`${route}|${next}|${track}`];
      if (counts) {
        const best = Object.entries(counts).filter(([k]) => cands.includes(k)).sort((a, b) => b[1] - a[1])[0];
        if (best && best[1] >= 3) return best[0];
      }
    }
    const hops: number[] = [];
    for (let i = 0; i + 1 < Math.min(upcoming.length, 4); i++) {
      const d = this.net.hop(upcoming[i], upcoming[i + 1]);
      if (Number.isFinite(d)) hops.push(d);
    }
    const dist = (c: string) => this.net.hop(c, next);
    if (hops.length === 0) return [...cands].sort((a, b) => dist(a) - dist(b))[0];
    const avg = hops.reduce((a, b) => a + b, 0) / hops.length;
    return [...cands].sort((a, b) => Math.abs(dist(a) - avg) - Math.abs(dist(b) - avg))[0];
  }
}

export { parentOf };
