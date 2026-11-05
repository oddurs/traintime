/**
 * The hierarchy builder was rewritten for speed — typed-array sorts, one pass over the samples for
 * every shape the gated fit tries, no string built per sample to index it — and it has to give
 * exactly the answers it gave before. The reference below is the previous implementation verbatim;
 * it is slow, which is the point of having replaced it, and right, which is the point of keeping it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildHierarchy, estimate, type BuildOptions, type HNode, type Hierarchy, type Sample } from "../src/lib/hierarchy";

// ---------- the previous implementation, kept as the oracle ----------
function quantile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function node(values: number[]): HNode {
  const sorted = [...values].sort((a, b) => a - b);
  const v = quantile(sorted, 0.5);
  const s = quantile(sorted.map((x) => Math.abs(x - v)).sort((a, b) => a - b), 0.68);
  return { v, s, n: values.length };
}

const sampleIndex = new WeakMap<Sample[], Map<string, Sample>>();
function keyOfSample(samples: Sample[], levels: string[], level: number, key: string, wanted: number): string | undefined {
  let index = sampleIndex.get(samples);
  if (!index) {
    index = new Map();
    for (const s of samples) {
      for (let i = 0; i < levels.length; i++) {
        const k2 = s.keys[i];
        if (k2 !== undefined && !index.has(`${i}|${k2}`)) index.set(`${i}|${k2}`, s);
      }
    }
    sampleIndex.set(samples, index);
  }
  return index.get(`${level}|${key}`)?.keys[wanted];
}

function referenceBuild(levels: string[], samples: Sample[], opts: BuildOptions = {}): Hierarchy {
  const k = opts.k ?? 12;
  const kByLevel = opts.kByLevel;
  const minN = opts.minN ?? 5;
  const minLift = opts.minLift ?? 1.5;
  const maxPerLevel = opts.maxPerLevel ?? 40_000;

  const buckets: Record<string, Map<string, number[]>> = {};
  for (const level of levels) buckets[level] = new Map();
  const all: number[] = [];
  for (const s of samples) {
    all.push(s.value);
    for (let i = 0; i < levels.length; i++) {
      const key = s.keys[i];
      if (key === undefined) continue;
      const m = buckets[levels[i]];
      (m.get(key) ?? m.set(key, []).get(key)!).push(s.value);
    }
  }

  const h: Hierarchy = { k, kByLevel, prior: node(all), levels, nodes: {} };
  for (const level of levels) {
    const kept: Record<string, HNode> = {};
    const entries = [...buckets[level].entries()]
      .filter(([, v]) => v.length >= minN)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, maxPerLevel);
    for (const [key, values] of entries) kept[key] = node(values);
    h.nodes[level] = kept;
  }

  // Second pass: with the full chain in place, discard cells that do not change the answer.
  for (let i = 0; i < levels.length; i++) {
    const level = levels[i];
    const kept: Record<string, HNode> = {};
    for (const [key, n] of Object.entries(h.nodes[level])) {
      const parentKeys = levels.map((_, j) => (j < i ? keyOfSample(samples, levels, i, key, j) : undefined));
      const parent = estimate({ ...h, nodes: { ...h.nodes, [level]: {} } }, parentKeys);
      if (Math.abs(n.v - parent.value) >= minLift) kept[key] = n;
    }
    h.nodes[level] = kept;
  }
  return h;
}

// ---------- generated samples ----------

/** mulberry32: small, seedable, and the same on every machine. */
function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LEVELS = ["route.daypart", "seg", "seg.daypart", "seg.how", "seg.weather"];

/**
 * Shaped like the runs the learner fits: segments shared by more than one route, so a cell's
 * parent depends on which sample reached it first; conditions that repeat; a weather level that
 * is often missing; values with ties, which is where a different sort would show.
 */
function samples(seed: number, n: number): Sample[] {
  const r = rng(seed);
  const out: Sample[] = [];
  for (let i = 0; i < n; i++) {
    const seg = `S${Math.floor(r() * 40)}>S${Math.floor(r() * 3)}`;
    const route = ["A", "C", "E"][Math.floor(r() * 3)];
    const daypart = ["am", "mid", "pm", "night"][Math.floor(r() * 4)];
    const how = Math.floor(r() * 12);
    const weather = r() < 0.4 ? undefined : ["clear", "rain"][Math.floor(r() * 2)];
    const base = 60 + (seg.length * 7) % 40 + (daypart === "pm" ? 15 : 0);
    const value = Math.round(base + (r() - 0.5) * 30 + (weather === "rain" ? 8 : 0));
    out.push({ value, keys: [`${route}|${daypart}`, seg, `${seg}|${daypart}`, `${seg}|h${how}`, weather ? `${seg}|${weather}` : undefined] });
  }
  return out;
}

const SHAPES: BuildOptions[] = [
  {},
  { k: 4, minN: 5, minLift: 1.5 },
  { k: 15, minN: 5, minLift: 1.5 },
  { k: 8, kByLevel: [6, 6, 20, 60, 60], minN: 5, minLift: 1.5 },
  { k: 8, kByLevel: [8, 8, 40, 150, 150], minN: 5, minLift: 1.5 },
  { k: 12, minN: 2, minLift: 0.5, maxPerLevel: 30 },
];

test("the hierarchy is built exactly as it was before, for every shape the gated fit tries", () => {
  for (const seed of [1, 2, 3]) {
    // One array reused across shapes, as the gated fit does, so the shared cells are exercised.
    const shared = samples(seed, 4000);
    for (const opts of SHAPES) {
      assert.deepEqual(buildHierarchy(LEVELS, shared, opts), referenceBuild(LEVELS, shared, opts), `seed ${seed}, ${JSON.stringify(opts)}`);
    }
  }
});

test("changing minN or the cap on the same samples is not served from the shared cells", () => {
  const shared = samples(7, 3000);
  const loose = buildHierarchy(LEVELS, shared, { minN: 2 });
  const strict = buildHierarchy(LEVELS, shared, { minN: 40 });
  assert.deepEqual(strict, referenceBuild(LEVELS, shared, { minN: 40 }));
  assert.notDeepEqual(loose, strict);
});

test("estimates from the rebuilt hierarchy match the old one's", () => {
  const train = samples(11, 5000);
  const opts = { k: 8, kByLevel: [6, 6, 20, 60, 60], minN: 5, minLift: 1.5 };
  const fast = buildHierarchy(LEVELS, train, opts), slow = referenceBuild(LEVELS, train, opts);
  for (const s of samples(12, 500)) assert.deepEqual(estimate(fast, s.keys), estimate(slow, s.keys));
});
