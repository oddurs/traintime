/**
 * Conditional estimates with empirical-Bayes shrinkage.
 *
 * How long a train takes between two stops depends on the hour of the week, the season, the
 * weather and how far behind the train ahead it is — but the more finely you condition, the
 * fewer observations each cell has. "Southbound 4 out of Grand Central at 08:15 on a rainy
 * Tuesday in March" might have five samples; "southbound 4 out of Grand Central" has thousands.
 * Fitting the narrow cell alone overfits; ignoring it throws the signal away.
 *
 * So each level is blended with the estimate that came before it, weighted by how much data it
 * has: `w = n / (n + k)`. A cell with plenty of observations speaks for itself, and a thin one
 * quietly inherits its parent. The same blend gives the spread, so σ widens by itself in
 * conditions we have rarely seen — which is exactly when it should.
 */

export interface HNode {
  /** Median of the observations in this cell. */
  v: number;
  /** Spread: the 68th percentile of |x − median|, i.e. a robust one-sigma. */
  s: number;
  n: number;
}

export interface Hierarchy {
  /**
   * Observations a cell needs before it mostly speaks for itself. A single number treats a
   * segment-wide cell and a segment-by-hour-by-weather cell as equally trustworthy at the same
   * count, which they are not: the finer the slice, the more likely a handful of observations
   * is noise, so each level can set its own bar.
   */
  k: number;
  kByLevel?: number[];
  prior: HNode;
  /** Level names, coarsest first. */
  levels: string[];
  nodes: Record<string, Record<string, HNode>>;
}

export interface Estimate {
  value: number;
  spread: number;
  /** Observations behind the most specific level that contributed. */
  n: number;
  /** Name of the finest level that had anything to say. */
  level: string;
}

/** Blend down the chain; `keys[i]` is the key for `levels[i]`, or undefined to skip that level. */
export function estimate(h: Hierarchy, keys: (string | undefined)[]): Estimate {
  let v = h.prior.v, s = h.prior.s, n = h.prior.n, level = "global";
  for (let i = 0; i < h.levels.length; i++) {
    const key = keys[i];
    if (key === undefined) continue;
    const node = h.nodes[h.levels[i]]?.[key];
    if (!node) continue;
    const w = node.n / (node.n + (h.kByLevel?.[i] ?? h.k));
    v = w * node.v + (1 - w) * v;
    s = w * node.s + (1 - w) * s;
    n = node.n;
    level = h.levels[i];
  }
  return { value: v, spread: s, n, level };
}

function quantile(sorted: ArrayLike<number>, p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

/** A typed array sorts numerically with no comparator, which is most of what a build costs. */
function node(values: ArrayLike<number>): HNode {
  const sorted = Float64Array.from(values).sort();
  const v = quantile(sorted, 0.5);
  const s = quantile(sorted.map((x) => Math.abs(x - v)).sort(), 0.68);
  return { v, s, n: values.length };
}

export interface BuildOptions {
  k?: number;
  /** Per-level evidence bar, coarsest first; falls back to `k`. */
  kByLevel?: number[];
  /** A cell needs at least this many observations to be kept at all. */
  minN?: number;
  /**
   * A cell is only kept if it moves the answer by at least this much against what its parents
   * already said. A cell that agrees with its parent costs bytes and changes nothing.
   */
  minLift?: number;
  /** Hard cap per level, keeping the cells with the most observations. */
  maxPerLevel?: number;
}

export interface Sample {
  value: number;
  /** One key per level, coarsest first; undefined skips that level for this sample. */
  keys: (string | undefined)[];
}

/**
 * The cells a set of samples supports before any pruning: every key with at least `minN`
 * observations, capped per level, summarised — and the first sample seen with each key.
 *
 * None of this depends on the shrinkage, so the gated fit, which tries four shapes on one training
 * set, reuses it rather than sorting ten million values into the same cells four times.
 */
interface Cells {
  levels: string[];
  minN: number;
  maxPerLevel: number;
  prior: HNode;
  nodes: Record<string, Record<string, HNode>>;
  /**
   * The parent key a cell inherits from. Keys are built as level-specific strings, so the parent
   * cannot be derived by truncation in general; the first sample that produced the cell is consulted.
   */
  first: Map<string, Sample>[];
}
const cellCache = new WeakMap<Sample[], Cells>();

function cellsOf(levels: string[], samples: Sample[], minN: number, maxPerLevel: number): Cells {
  const hit = cellCache.get(samples);
  if (hit && hit.levels === levels && hit.minN === minN && hit.maxPerLevel === maxPerLevel) return hit;

  const buckets = levels.map(() => new Map<string, number[]>());
  const first = levels.map(() => new Map<string, Sample>());
  const all = new Float64Array(samples.length);
  for (let j = 0; j < samples.length; j++) {
    const s = samples[j];
    all[j] = s.value;
    for (let i = 0; i < levels.length; i++) {
      const key = s.keys[i];
      if (key === undefined) continue;
      const values = buckets[i].get(key);
      if (values) values.push(s.value);
      else {
        buckets[i].set(key, [s.value]);
        first[i].set(key, s);
      }
    }
  }

  const nodes: Record<string, Record<string, HNode>> = {};
  for (let i = 0; i < levels.length; i++) {
    const kept: Record<string, HNode> = {};
    const entries = [...buckets[i].entries()]
      .filter(([, v]) => v.length >= minN)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, maxPerLevel);
    for (const [key, values] of entries) kept[key] = node(values);
    nodes[levels[i]] = kept;
  }
  const cells: Cells = { levels, minN, maxPerLevel, prior: node(all), nodes, first };
  cellCache.set(samples, cells);
  return cells;
}

/**
 * Build the hierarchy, then drop every cell that does not earn its place: too few observations,
 * or too close to what its parents already predicted.
 */
export function buildHierarchy(levels: string[], samples: Sample[], opts: BuildOptions = {}): Hierarchy {
  const k = opts.k ?? 12;
  const kByLevel = opts.kByLevel;
  const minN = opts.minN ?? 5;
  const minLift = opts.minLift ?? 1.5;
  const maxPerLevel = opts.maxPerLevel ?? 40_000;

  const cells = cellsOf(levels, samples, minN, maxPerLevel);
  const h: Hierarchy = { k, kByLevel, prior: cells.prior, levels, nodes: { ...cells.nodes } };

  // Second pass: with the full chain in place, discard cells that do not change the answer.
  for (let i = 0; i < levels.length; i++) {
    const level = levels[i];
    const withoutLevel = { ...h, nodes: { ...h.nodes, [level]: {} } };
    const kept: Record<string, HNode> = {};
    for (const [key, n] of Object.entries(h.nodes[level])) {
      const from = cells.first[i].get(key);
      const parentKeys = levels.map((_, j) => (j < i ? from?.keys[j] : undefined));
      const parent = estimate(withoutLevel, parentKeys);
      if (Math.abs(n.v - parent.value) >= minLift) kept[key] = n;
    }
    h.nodes[level] = kept;
  }
  return h;
}

/** Rough byte cost, for keeping an eye on what gets shipped to the browser. */
export function hierarchySize(h: Hierarchy): { nodes: number; byLevel: Record<string, number> } {
  const byLevel: Record<string, number> = {};
  let nodes = 0;
  for (const level of h.levels) {
    const n = Object.keys(h.nodes[level] ?? {}).length;
    byLevel[level] = n;
    nodes += n;
  }
  return { nodes, byLevel };
}
