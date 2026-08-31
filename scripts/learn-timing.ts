/**
 * Learn run times, dwell, approach times, ETA residuals and track→predecessor counts from the
 * recorded station events, and write data/timing.json for the poller (hot-reloaded).
 *
 *   npx tsx scripts/learn-timing.ts [--from ISO] [--to ISO] [--out data/timing.json] [--no-flush]
 */
import { DuckDBInstance } from "@duckdb/node-api";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ResidualStat, Stat, TimingTables } from "../src/lib/types";
import { horizonBucket, runKeys, dwellKeys, RUN_LEVELS, DWELL_LEVELS, type Conditions } from "../src/lib/timing";
import { buildHierarchy, estimate, hierarchySize } from "../src/lib/hierarchy";
import { band, calendarRow, type WeatherBand } from "../src/lib/calendar";
import { nyHourDow } from "../src/lib/tracker";
import { parquetGlob } from "../services/poller/recorder";

const ROOT = join(import.meta.dirname, "..");
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) args.set(a.slice(2), process.argv[i + 1]?.startsWith("--") || process.argv[i + 1] === undefined ? "true" : process.argv[++i]);
}
const toEpoch = (v?: string) => (v ? (Number.isFinite(Number(v)) ? Number(v) : Math.floor(new Date(v).getTime() / 1000)) : undefined);

// Shrinkage settings, tunable so they can be chosen by measurement rather than taste.
const HIER_K = Number(process.env.HIER_K ?? 12);
const HIER_MIN_N = Number(process.env.HIER_MIN_N ?? 5);
const HIER_MIN_LIFT = Number(process.env.HIER_MIN_LIFT ?? 1.5);

const quantile = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
const stat = (xs: number[]): Stat => ({ p50: quantile(xs, 0.5), p16: quantile(xs, 0.16), p84: quantile(xs, 0.84), n: xs.length });
const residualStat = (xs: number[]): ResidualStat => {
  const median = quantile(xs, 0.5);
  return { median, p68: quantile(xs.map((x) => Math.abs(x - median)), 0.68), n: xs.length };
};
function group<T>(rows: T[], key: (r: T) => string | undefined, val: (r: T) => number): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const r of rows) {
    const k = key(r);
    if (k === undefined) continue;
    (out[k] ??= []).push(val(r));
  }
  return out;
}
const mapStats = (g: Record<string, number[]>, min = 3) => Object.fromEntries(Object.entries(g).filter(([, v]) => v.length >= min).map(([k, v]) => [k, stat(v)]));

async function main() {
  if (!args.get("no-flush")) { try { await fetch("http://localhost:7118/flush"); } catch { /* fine */ } }
  const from = toEpoch(args.get("from"));
  const to = toEpoch(args.get("to"));
  const out = args.get("out") ?? join(process.env.TRAINTIME_DATA_DIR ?? join(ROOT, "data"), "timing.json");
  const db = await DuckDBInstance.create(":memory:");
  const conn = await db.connect();
  const range = [from ? `ts >= ${from}` : "", to ? `ts <= ${to}` : ""].filter(Boolean).join(" AND ") || "true";
  await conn.run(`CREATE VIEW ev AS SELECT * FROM read_parquet('${parquetGlob("events")}', union_by_name=true) WHERE ${range}`);
  await conn.run(`CREATE VIEW eo AS SELECT * FROM read_parquet('${parquetGlob("eta_obs")}', union_by_name=true) WHERE ${range.replace(/\bts\b/g, "obs_ts")}`);

  // Consecutive events per trip; `incoming` is excluded from the stop-to-stop sequence so a
  // departure pairs with the following arrival even when an approach event sits between them.
  type Pair = { ts: number; route: string; direction: string; stop_id: string; kind: string; track: string | null; estimated: boolean; next_ts: number | null; next_stop: string | null; next_kind: string | null; next_track: string | null; next_est: boolean | null };
  const consecutive = async (kinds: string[]) => (await conn.runAndReadAll(`
    SELECT ts::DOUBLE AS ts, route, direction, stop_id, kind, track, estimated,
           (lead(ts) OVER w)::DOUBLE AS next_ts, lead(stop_id) OVER w AS next_stop, lead(kind) OVER w AS next_kind,
           lead(track) OVER w AS next_track, lead(estimated) OVER w AS next_est
    FROM ev WHERE kind IN (${kinds.map((k) => `'${k}'`).join(",")})
    WINDOW w AS (PARTITION BY trip_id ORDER BY ts, CASE kind WHEN 'arrive' THEN 0 WHEN 'incoming' THEN 0 ELSE 1 END)
  `)).getRowObjectsJS() as Pair[];
  const stopPairs = await consecutive(["arrive", "depart", "pass"]);
  const pairs = await consecutive(["arrive", "depart", "pass", "incoming"]);

  const runs = stopPairs.filter((p) => (p.kind === "depart" || p.kind === "pass") && (p.next_kind === "arrive" || p.next_kind === "pass") && p.next_stop && p.next_stop !== p.stop_id && !p.estimated && !p.next_est && p.next_ts! - p.ts > 10 && p.next_ts! - p.ts < 1800);
  const dwells = stopPairs.filter((p) => p.kind === "arrive" && p.next_kind === "depart" && p.next_stop === p.stop_id && !p.estimated && !p.next_est && p.next_ts! - p.ts >= 5 && p.next_ts! - p.ts < 900);
  const approaches = pairs.filter((p) => p.kind === "incoming" && p.next_kind === "arrive" && p.next_stop === p.stop_id && !p.estimated && !p.next_est && p.next_ts! - p.ts > 0 && p.next_ts! - p.ts < 600);
  const hourOf = (ts: number) => nyHourDow(ts).hour;

  const runTime = mapStats(group(runs, (p) => `${p.stop_id}>${p.next_stop}`, (p) => p.next_ts! - p.ts));
  const runTimeHour = mapStats(group(runs, (p) => `${p.stop_id}>${p.next_stop}@${hourOf(p.ts)}`, (p) => p.next_ts! - p.ts));
  const dwell = mapStats(group(dwells, (p) => p.stop_id, (p) => p.next_ts! - p.ts));
  const dwellHour = mapStats(group(dwells, (p) => `${p.stop_id}@${hourOf(p.ts)}`, (p) => p.next_ts! - p.ts));
  const approach = mapStats(group(approaches, (p) => p.stop_id, (p) => p.next_ts! - p.ts));

  // Arrival-to-arrival between consecutive arrivals of the same trip: observable on every feed.
  const arrivals = (await conn.runAndReadAll(`
    SELECT ts::DOUBLE AS ts, stop_id, (lead(ts) OVER w)::DOUBLE AS next_ts, lead(stop_id) OVER w AS next_stop
    FROM ev WHERE kind = 'arrive' AND NOT estimated WINDOW w AS (PARTITION BY trip_id ORDER BY ts)
  `)).getRowObjectsJS() as { ts: number; stop_id: string; next_ts: number | null; next_stop: string | null }[];
  const a2aPairs = arrivals.filter((p) => p.next_stop && p.next_stop !== p.stop_id && p.next_ts! - p.ts > 20 && p.next_ts! - p.ts < 1800);
  const a2a = mapStats(group(a2aPairs, (p) => `${p.stop_id}>${p.next_stop}`, (p) => p.next_ts! - p.ts));
  const dwellMedians = Object.values(dwell).map((s) => s.p50);
  const dwellGlobal = dwellMedians.length >= 5 ? quantile(dwellMedians, 0.5) : 35;

  // --- Conditional hierarchies -------------------------------------------------
  // Weather is recorded hourly and joined here. It only started being recorded when the
  // context recorder first ran, so early history simply has no weather level — the hierarchy
  // skips levels it has nothing for.
  const bandByHour = new Map<number, WeatherBand>();
  try {
    const wrows = (await conn.runAndReadAll(
      `SELECT hour::DOUBLE AS hour, precip_mm, snow_cm, code FROM read_parquet('${parquetGlob("weather")}', union_by_name=true)`,
    )).getRowObjectsJS() as { hour: number; precip_mm: number; snow_cm: number; code: number }[];
    for (const w of wrows) bandByHour.set(w.hour, band(w));
  } catch { /* no weather recorded yet */ }

  const condOf = (ts: number): Conditions => {
    const c = calendarRow(ts);
    return {
      hourOfWeek: c.hour_of_week, daypart: c.daypart, season: c.season,
      weather: bandByHour.get(Math.floor(ts / 3600) * 3600),
    };
  };

  /**
   * Build the hierarchy, then earn the right to use it. A candidate is fitted on the older
   * three quarters of the observations and scored against the newest quarter, alongside the
   * plain per-cell median that the flat tables already provide. Several shrinkage constants are
   * tried and the best is kept — but only if it beats the simple estimator outright. Extra model
   * complexity has to pay for itself on data it has not seen.
   */
  function gatedHierarchy<T extends { ts: number }>(
    levels: string[],
    rows: T[],
    value: (r: T) => number,
    keysOf: (r: T) => (string | undefined)[],
    /** Which level holds the plain per-cell estimate the hierarchy has to beat. */
    flatLevel: number,
  ) {
    const sorted = [...rows].sort((a, b) => a.ts - b.ts);
    const cut = Math.floor(sorted.length * 0.75);
    const train = sorted.slice(0, cut), test = sorted.slice(cut);
    const asSample = (r: T) => ({ value: value(r), keys: keysOf(r) });

    // The incumbent: the median of each flat cell, falling back to the overall median.
    const flatCells = new Map<string, number[]>();
    for (const r of train) {
      const key = keysOf(r)[flatLevel];
      if (key === undefined) continue;
      (flatCells.get(key) ?? flatCells.set(key, []).get(key)!).push(value(r));
    }
    const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
    const globalMed = med(train.map(value));
    const flatOf = (r: T) => {
      const key = keysOf(r)[flatLevel];
      const cell = key === undefined ? undefined : flatCells.get(key);
      return cell && cell.length >= 3 ? med(cell) : globalMed;
    };
    const mae = (f: (r: T) => number) => (test.length ? test.reduce((s, r) => s + Math.abs(value(r) - f(r)), 0) / test.length : Infinity);
    const flatMae = mae(flatOf);

    // Candidate shapes: a flat evidence bar, and ones that rise with how finely a cell slices
    // the data, so a handful of observations in a narrow cell cannot outvote a well-measured
    // parent. Whichever scores best on the held-out window is the one considered.
    const shapes: { label: string; k: number; kByLevel?: number[] }[] = [
      { label: "flat-4", k: 4 },
      { label: "flat-15", k: 15 },
      { label: "rising", k: 8, kByLevel: [6, 6, 20, 60, 60] },
      { label: "steep", k: 8, kByLevel: [8, 8, 40, 150, 150] },
    ];
    let best: { label: string; k: number; hierMae: number; hier: ReturnType<typeof buildHierarchy> } = {
      label: "none", k: 0, hierMae: Infinity,
      hier: buildHierarchy(levels, rows.map(asSample), { k: HIER_K, minN: HIER_MIN_N, minLift: HIER_MIN_LIFT }),
    };
    for (const shape of shapes) {
      const opts = { k: shape.k, kByLevel: shape.kByLevel, minN: HIER_MIN_N, minLift: HIER_MIN_LIFT };
      const fitted = buildHierarchy(levels, train.map(asSample), opts);
      const m = mae((r) => estimate(fitted, keysOf(r)).value);
      if (m < best.hierMae) best = { label: shape.label, k: shape.k, hierMae: m, hier: buildHierarchy(levels, rows.map(asSample), opts) };
    }
    const active = best.hierMae < flatMae;
    return { hier: best.hier, gate: { active, k: best.k, shape: best.label, flatMae, hierMae: best.hierMae, testRows: test.length } };
  }

  const runFit = gatedHierarchy(
    RUN_LEVELS, runs.filter((p) => p.next_stop),
    (p) => p.next_ts! - p.ts,
    (p) => runKeys(p.route, p.stop_id, p.next_stop!, condOf(p.ts)),
    1, // "seg"
  );
  const dwellFit = gatedHierarchy(
    DWELL_LEVELS, dwells,
    (p) => p.next_ts! - p.ts,
    (p) => dwellKeys(p.stop_id, condOf(p.ts)),
    1, // "stop"
  );
  const runHier = runFit.hier, dwellHier = dwellFit.hier;

  const prevByTrack: Record<string, Record<string, number>> = {};
  for (const p of runs) {
    if (!p.next_track) continue;
    const k = `${p.route}|${p.next_stop}|${p.next_track}`;
    (prevByTrack[k] ??= {})[p.stop_id] = ((prevByTrack[k] ??= {})[p.stop_id] ?? 0) + 1;
  }

  // ETA residuals: every observation joined to the actual (non-estimated) arrival at that stop.
  const obs = (await conn.runAndReadAll(`
    SELECT eo.obs_ts::DOUBLE AS obs_ts, eo.predicted::DOUBLE AS predicted, eo.prev_stop, eo.route, eo.stop_id, ev.ts::DOUBLE AS actual
    FROM eo JOIN ev ON ev.trip_id = eo.trip_id AND ev.stop_id = eo.stop_id AND ev.kind = 'arrive' AND NOT ev.estimated
    WHERE ev.ts >= eo.obs_ts - 5 AND eo.predicted - eo.obs_ts >= -30
  `)).getRowObjectsJS() as { obs_ts: number; predicted: number; prev_stop: string | null; route: string; stop_id: string; actual: number }[];
  const clean = obs.filter((o) => Math.abs(o.actual - o.predicted) < 900);
  const resid = (o: (typeof clean)[number]) => o.actual - o.predicted;
  const bucket = (o: (typeof clean)[number]) => horizonBucket(o.predicted - o.obs_ts);
  const residual: Record<string, ResidualStat> = {};
  for (const [k, v] of Object.entries(group(clean, (o) => (o.prev_stop ? `seg:${o.prev_stop}>${o.stop_id}|${bucket(o)}` : undefined), resid))) residual[k] = residualStat(v);
  for (const [k, v] of Object.entries(group(clean, (o) => `route:${o.route}|${bucket(o)}`, resid))) residual[k] = residualStat(v);
  for (const [k, v] of Object.entries(group(clean, (o) => `all|${bucket(o)}`, resid))) residual[k] = residualStat(v);

  const nEvents = Number((await conn.runAndReadAll(`SELECT count(*) AS n FROM ev`)).getRowObjects()[0].n);
  const window = (await conn.runAndReadAll(`SELECT min(ts) AS a, max(ts) AS b FROM ev`)).getRowObjects()[0];
  const tables: TimingTables = {
    generatedAt: new Date().toISOString(),
    window: { from: new Date(Number(window.a) * 1000).toISOString(), to: new Date(Number(window.b) * 1000).toISOString() },
    samples: { events: nEvents, etaObs: clean.length },
    runHier, dwellHier, hierGate: { run: runFit.gate, dwell: dwellFit.gate },
    runTime, runTimeHour, a2a, dwellGlobal, dwell, dwellHour, approach, residual, prevByTrack,
  };
  mkdirSync(join(out, ".."), { recursive: true });
  writeFileSync(out, JSON.stringify(tables));

  console.log(`events ${nEvents} · runs ${runs.length} · dwells ${dwells.length} · approaches ${approaches.length} · eta obs ${clean.length}`);
  const rs = hierarchySize(runHier), ds = hierarchySize(dwellHier);
  console.log(`run hierarchy: ${rs.nodes} cells ${JSON.stringify(rs.byLevel)} (prior ${runHier.prior.v}s over ${runHier.prior.n})`);
  console.log(`dwell hierarchy: ${ds.nodes} cells ${JSON.stringify(ds.byLevel)} (prior ${dwellHier.prior.v}s over ${dwellHier.prior.n})`);
  const g = (n: string, x: { active: boolean; k: number; shape?: string; flatMae: number; hierMae: number; testRows: number }) =>
    `${n}: ${x.active ? "ACTIVE" : "off"} (${x.shape}, ${x.hierMae.toFixed(1)}s vs flat ${x.flatMae.toFixed(1)}s on ${x.testRows} held out)`;
  console.log(g("run conditioning", runFit.gate));
  console.log(g("dwell conditioning", dwellFit.gate));
  console.log(`weather hours joined: ${bandByHour.size}`);
  console.log(`segments with run time ${Object.keys(runTime).length} · arrival-to-arrival ${Object.keys(a2a).length} · stops with dwell ${Object.keys(dwell).length} (global prior ${dwellGlobal} s) · residual groups ${Object.keys(residual).length}`);
  for (const b of ["h0", "h1", "h2", "h3", "h4"]) {
    const r = residual[`all|${b}`];
    if (r) console.log(`  residual ${b}: median ${r.median.toFixed(1)} s, 1σ ${r.p68.toFixed(1)} s, n=${r.n}`);
  }
  console.log(`wrote ${out}`);
  conn.closeSync();
  db.closeSync();
}

main().catch((e) => { console.error(e); process.exit(1); });
