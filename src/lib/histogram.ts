/**
 * Counts in buckets, which is all a quantile needs.
 *
 * The engine learns by taking medians and spreads over cells — this segment, at this hour, in this
 * weather. Keeping every observation to do that costs 16 MB a day, which is 5.8 GB a year against
 * a 5 GB volume, so the data that would let us learn about seasons and holidays is exactly the
 * data that expires before a year is out.
 *
 * A histogram is the sufficient statistic. It answers the same questions to within its bucket
 * width, it merges by adding counts, and a year of it is a few hundred megabytes. Nothing the
 * model learns from is lost by keeping this instead of the rows.
 */
import type { ResidualStat } from "./types";

/** Seconds per bucket. Two is finer than any decision made from these numbers. */
export const BUCKET_S = 2;

/** Bucket index for a value in seconds; negative values bucket symmetrically. */
export const bucketOf = (seconds: number) => Math.floor(seconds / BUCKET_S);
/** The middle of a bucket, which is the best estimate of any value inside it. */
export const bucketMid = (index: number) => index * BUCKET_S + BUCKET_S / 2;

/** Bucket index -> count. */
export type Histogram = Map<number, number>;

export function add(h: Histogram, seconds: number, times = 1): void {
  const b = bucketOf(seconds);
  h.set(b, (h.get(b) ?? 0) + times);
}

export function merge(into: Histogram, from: Histogram): void {
  for (const [b, n] of from) into.set(b, (into.get(b) ?? 0) + n);
}

export const total = (h: Histogram) => { let n = 0; for (const c of h.values()) n += c; return n; };

/**
 * The value below which `q` of the mass lies. Buckets are walked in order and the crossing bucket's
 * midpoint returned — within a second of the true quantile at this width, which is well inside the
 * noise of anything measured here.
 */
export function quantile(h: Histogram, q: number): number {
  const n = total(h);
  if (n === 0) return 0;
  const want = q * n;
  let seen = 0;
  for (const b of [...h.keys()].sort((a, b2) => a - b2)) {
    seen += h.get(b)!;
    if (seen >= want) return bucketMid(b);
  }
  return bucketMid(Math.max(...h.keys()));
}

/**
 * The median and the 68th percentile of absolute deviation from it — the same pair the learner
 * takes from raw observations, so a table built from histograms and one built from rows agree.
 */
export function stat(h: Histogram): ResidualStat {
  const median = quantile(h, 0.5);
  const spread: Histogram = new Map();
  for (const [b, n] of h) add(spread, Math.abs(bucketMid(b) - median), n);
  return { median, p68: quantile(spread, 0.68), n: total(h) };
}
