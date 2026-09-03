/**
 * What the page was actually like, measured by the browsers it happened in.
 *
 * Everything we knew about front-end performance came from one scripted Chrome on one machine,
 * throttled to a guess at a slow connection. That measurement is repeatable, which is why it is
 * worth keeping — but it is one device, one network and one cold cache, and it cannot tell us
 * whether the page a rider on a platform actually opened took two seconds or twelve.
 *
 * So the page reports its own milestones, and this keeps the recent ones and answers with
 * percentiles. A median is the number that describes a typical visit; the 90th is the one that
 * describes the visits people give up on, and it is the only one that moves when something is
 * wrong for a minority — which, on a transit map, is everyone on a train.
 *
 * The endpoint feeding this is unauthenticated and on the public internet, so nothing here trusts
 * its input: every field is optional, every number is bounded, anything unrecognised is dropped
 * rather than stored, and the whole store is a fixed-size ring that forgets. The worst a hostile
 * poster can do is make the percentiles wrong.
 */

/** The milestones, in the order a page reaches them. */
export const METRICS = ["ttfb", "fcp", "readable", "map"] as const;
export type Metric = (typeof METRICS)[number];

/** The connection classes the Network Information API reports. Anything else is not recorded. */
const NET_CLASSES = new Set(["slow-2g", "2g", "3g", "4g"]);

/**
 * Longer than this and the number is not a measurement.
 *
 * A tab left open in the background and restored an hour later reports an hour, and one such
 * sample would drag a p90 computed from a few hundred into meaninglessness.
 */
const CEILING_MS = 120_000;

const WINDOW_S = 3600;
const MAX_SAMPLES = 500;

export interface TimingSample {
  at: number;
  ttfb?: number;
  fcp?: number;
  readable?: number;
  map?: number;
  /** navigator.hardwareConcurrency and deviceMemory: how much machine the page had to run on. */
  cpu?: number;
  mem?: number;
  /** effectiveType: what kind of connection it had to arrive over. */
  net?: string;
}

/** A number that came from the internet, or undefined. */
function ms(v: unknown): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  const n = Math.round(v);
  return n >= 0 && n <= CEILING_MS ? n : undefined;
}

function small(v: unknown, max: number): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  const n = Math.round(v);
  return n > 0 && n <= max ? n : undefined;
}

/**
 * Read a posted body into a sample, or nothing at all.
 *
 * Returns null when there is no timing in it. A body with only a connection class in it is not a
 * measurement of anything, and counting it would inflate the sample count with visits we learned
 * nothing from.
 */
export function parseSample(body: unknown, at: number): TimingSample | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const s: TimingSample = {
    at,
    ttfb: ms(b.ttfb),
    fcp: ms(b.fcp),
    readable: ms(b.readable),
    map: ms(b.map),
    cpu: small(b.cpu, 256),
    mem: small(b.mem, 128),
    net: typeof b.net === "string" && NET_CLASSES.has(b.net) ? b.net : undefined,
  };
  // A report that the page never became readable is a measurement, and the most important one
  // here — so a sample counts if it carries any milestone, readable included by its absence
  // only when something else in it was measured.
  return METRICS.some((m) => s[m] !== undefined) ? s : null;
}

/**
 * Nearest-rank percentile over ascending values.
 *
 * Deliberately not interpolated: these are milliseconds from real page loads, and a p90 that is
 * an average of two observations is harder to reason about than one that is an observation.
 */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

export interface MetricReport {
  n: number;
  p50: number;
  p90: number;
  worst: number;
}

export interface RumReport {
  samples: number;
  /** Pages that reported a paint but never reached anything a rider could read. */
  neverReadable: number;
  net: Record<string, number>;
  ttfb?: MetricReport;
  fcp?: MetricReport;
  readable?: MetricReport;
  map?: MetricReport;
}

/** The recent samples, and what they say. */
export class Rum {
  private samples: TimingSample[] = [];

  add(s: TimingSample) {
    this.samples.push(s);
    if (this.samples.length > MAX_SAMPLES) this.samples.shift();
  }

  /** Everything still inside the window, oldest first. */
  recent(now: number): TimingSample[] {
    this.samples = this.samples.filter((s) => s.at > now - WINDOW_S);
    return this.samples;
  }

  report(now: number): RumReport {
    const recent = this.recent(now);
    const out: RumReport = { samples: recent.length, neverReadable: 0, net: {} };
    for (const s of recent) {
      // A page that painted and then never got a board on screen is the failure this is for.
      if (s.fcp !== undefined && s.readable === undefined) out.neverReadable++;
      if (s.net) out.net[s.net] = (out.net[s.net] ?? 0) + 1;
    }
    for (const m of METRICS) {
      const vs = recent.map((s) => s[m]).filter((v): v is number => v !== undefined).sort((a, b) => a - b);
      if (vs.length) out[m] = { n: vs.length, p50: percentile(vs, 50), p90: percentile(vs, 90), worst: vs[vs.length - 1] };
    }
    return out;
  }
}
