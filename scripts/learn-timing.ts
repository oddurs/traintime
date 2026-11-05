/**
 * Learn run times, dwell, approach times, ETA residuals and track→predecessor counts from the
 * recorded station events, and write data/timing.json for the poller (hot-reloaded).
 *
 *   npx tsx scripts/learn-timing.ts [--from ISO] [--to ISO] [--out data/timing.json] [--no-flush]
 *
 * It runs nightly beside a live recorder, so it is written to hold as little as it can: DuckDB
 * does the filtering and the counting, rows are streamed a chunk at a time, and what does have to
 * reach JS — the ten million runs and dwells the hierarchies are fitted on — is kept as numbers.
 * It used to read every stop event in history as an object, 21 million of them twice over beside
 * 20 million observations, and keep a tenth: 16.8 GB at 80 days of history, growing by the day.
 */
import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DuckDBConnection } from "@duckdb/node-api";
import type { ResidualStat, Stat, TimingTables } from "../src/lib/types";
import { HORIZONS, runKeys, dwellKeys, RUN_LEVELS, DWELL_LEVELS, type Conditions } from "../src/lib/timing";
import { BUCKET_S, stat as statFromHistogram, type Histogram } from "../src/lib/histogram";
import { buildHierarchy, estimate, hierarchySize, type Sample } from "../src/lib/hierarchy";
import { band, calendarRow, type WeatherBand } from "../src/lib/calendar";
import { nyHourDow } from "../src/lib/tracker";
import { parquetGlob, REC_DIR } from "../services/poller/recorder";
import { BUDGET, openDuckDB } from "../services/poller/memory";

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

/** Streams a query's rows a chunk at a time, so no result is ever held whole in memory. */
async function eachRow(conn: DuckDBConnection, sql: string, fn: (row: unknown[]) => void): Promise<void> {
  const result = await conn.stream(sql);
  for await (const rows of result.yieldRowsJs()) for (const r of rows) fn(r);
}

/** Each distinct string once, as a small integer. Ten million rows name a few thousand stops. */
class Dict {
  private codes = new Map<string, number>();
  readonly names: string[] = [];
  code(s: string): number {
    let c = this.codes.get(s);
    if (c === undefined) {
      c = this.names.length;
      this.codes.set(s, c);
      this.names.push(s);
    }
    return c;
  }
}

/** Collects values under a numeric key and summarises each group with at least `min` of them. */
function statsBy(keys: number[], values: number[], name: (key: number) => string, min = 3): Record<string, Stat> {
  const groups = new Map<number, number[]>();
  for (let i = 0; i < keys.length; i++) {
    const g = groups.get(keys[i]);
    if (g) g.push(values[i]);
    else groups.set(keys[i], [values[i]]);
  }
  const out: Record<string, Stat> = {};
  for (const [k, v] of groups) if (v.length >= min) out[name(k)] = stat(v);
  return out;
}

/**
 * One sample per row, with rows that have the same keys sharing one array. `keyOf` returns a
 * numeric identity for the row's keys and a way to build them the first time that identity is seen,
 * so ten million samples point at a few hundred thousand arrays instead of building five strings each.
 */
function samplesOf(n: number, value: (i: number) => number, keyOf: (i: number) => [number, () => (string | undefined)[]]): Sample[] {
  const shared = new Map<number, (string | undefined)[]>();
  const out: Sample[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const [id, build] = keyOf(i);
    let keys = shared.get(id);
    if (!keys) {
      keys = build();
      shared.set(id, keys);
    }
    out[i] = { value: value(i), keys };
  }
  return out;
}

/**
 * Build the hierarchy, then earn the right to use it. A candidate is fitted on the older
 * three quarters of the observations and scored against the newest quarter, alongside the
 * plain per-cell median that the flat tables already provide. Several shrinkage constants are
 * tried and the best is kept — but only if it beats the simple estimator outright. Extra model
 * complexity has to pay for itself on data it has not seen.
 *
 * `samples` must arrive in time order; the queries that produce them sort by time.
 */
function gatedHierarchy(
  levels: string[],
  samples: Sample[],
  /** Which level holds the plain per-cell estimate the hierarchy has to beat. */
  flatLevel: number,
) {
  const cut = Math.floor(samples.length * 0.75);
  const train = samples.slice(0, cut), test = samples.slice(cut);

  // The incumbent: the median of each flat cell, falling back to the overall median. Each cell's
  // median is taken once — it used to be re-sorted for every held-out row that looked it up.
  const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
  const flatCells = new Map<string, number[]>();
  for (const s of train) {
    const key = s.keys[flatLevel];
    if (key === undefined) continue;
    const cell = flatCells.get(key);
    if (cell) cell.push(s.value);
    else flatCells.set(key, [s.value]);
  }
  const flatMedian = new Map<string, number>();
  for (const [key, cell] of flatCells) if (cell.length >= 3) flatMedian.set(key, med(cell));
  flatCells.clear();
  const globalMed = med(train.map((s) => s.value));
  const flatOf = (s: Sample) => {
    const key = s.keys[flatLevel];
    return (key === undefined ? undefined : flatMedian.get(key)) ?? globalMed;
  };
  const mae = (f: (s: Sample) => number) => (test.length ? test.reduce((sum, s) => sum + Math.abs(s.value - f(s)), 0) / test.length : Infinity);
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
  let best: { label: string; k: number; hierMae: number; opts: Parameters<typeof buildHierarchy>[2] } = {
    label: "none", k: 0, hierMae: Infinity, opts: { k: HIER_K, minN: HIER_MIN_N, minLift: HIER_MIN_LIFT },
  };
  for (const shape of shapes) {
    const opts = { k: shape.k, kByLevel: shape.kByLevel, minN: HIER_MIN_N, minLift: HIER_MIN_LIFT };
    const fitted = buildHierarchy(levels, train, opts);
    const m = mae((s) => estimate(fitted, s.keys).value);
    if (m < best.hierMae) best = { label: shape.label, k: shape.k, hierMae: m, opts };
  }
  // Refitted on everything once, for the winner only, rather than every time the lead changed hands.
  const hier = buildHierarchy(levels, samples, best.opts);
  const active = best.hierMae < flatMae;
  return { hier, gate: { active, k: best.k, shape: best.label, flatMae, hierMae: best.hierMae, testRows: test.length } };
}

async function main() {
  if (!args.get("no-flush")) { try { await fetch("http://localhost:7118/flush"); } catch { /* fine */ } }
  const from = toEpoch(args.get("from"));
  const to = toEpoch(args.get("to"));
  const out = args.get("out") ?? join(process.env.TRAINTIME_DATA_DIR ?? join(ROOT, "data"), "timing.json");
  const db = await openDuckDB(BUDGET.learnerDuckdb);
  const conn = await db.connect();
  const range = [from ? `ts >= ${from}` : "", to ? `ts <= ${to}` : ""].filter(Boolean).join(" AND ") || "true";
  await conn.run(`CREATE VIEW ev AS SELECT * FROM read_parquet('${parquetGlob("events")}', union_by_name=true) WHERE ${range}`);
  await conn.run(`CREATE VIEW eo AS SELECT * FROM read_parquet('${parquetGlob("eta_obs")}', union_by_name=true) WHERE ${range.replace(/\bts\b/g, "obs_ts")}`);

  /*
   * Consecutive events per trip; `incoming` is excluded from the stop-to-stop sequence so a
   * departure pairs with the following arrival even when an approach event sits between them.
   * Two events of one trip can share a second, and the feed repeats some outright; everything
   * else in the row breaks the tie, so that two builds over the same history pair the same events
   * and sort them the same way — the gate compares tables, and a comparison is only as good as
   * its inputs are repeatable.
   * The coalesces keep the JS truthiness these filters used to be written in: a file recorded
   * before `estimated` existed reads as not estimated.
   */
  const consecutive = (kinds: string[]) => `
    SELECT ts::DOUBLE AS ts, route, stop_id, kind, coalesce(estimated, false) AS est,
           (lead(ts) OVER w)::DOUBLE AS next_ts, lead(stop_id) OVER w AS next_stop, lead(kind) OVER w AS next_kind,
           lead(track) OVER w AS next_track, coalesce(lead(estimated) OVER w, false) AS next_est
    FROM ev WHERE kind IN (${kinds.map((k) => `'${k}'`).join(",")})
    WINDOW w AS (PARTITION BY trip_id ORDER BY ts, CASE kind WHEN 'arrive' THEN 0 WHEN 'incoming' THEN 0 ELSE 1 END, stop_id, kind, track, estimated)`;
  const STOP_KINDS = ["arrive", "depart", "pass"];

  // Weather is recorded hourly and joined here. It only started being recorded when the
  // context recorder first ran, so early history simply has no weather level — the hierarchy
  // skips levels it has nothing for.
  const bandByHour = new Map<number, WeatherBand>();
  try {
    await eachRow(conn, `SELECT hour::DOUBLE, precip_mm, snow_cm, code FROM read_parquet('${parquetGlob("weather")}', union_by_name=true)`,
      ([hour, precip_mm, snow_cm, code]) => bandByHour.set(hour as number, band({ precip_mm, snow_cm, code } as Parameters<typeof band>[0])));
  } catch { /* no weather recorded yet */ }

  /*
   * Everything a row's conditions depend on is fixed for the hour: New York's offset is a whole
   * number of hours, so its local hours start on UTC ones, and weather is recorded by the hour.
   * So it is computed once an hour rather than once a row a fit — `calendarRow` is an Intl call,
   * and the gated fit made it about ten times for each of ten million rows.
   */
  const COND_SPACE = 1 << 15;
  const conds = new Dict();
  const byHour = new Map<number, { hour: number; cond: number; c: Conditions }>();
  const hourInfo = (ts: number) => {
    const h = Math.floor(ts / 3600);
    let info = byHour.get(h);
    if (!info) {
      const cal = calendarRow(ts);
      const c: Conditions = { hourOfWeek: cal.hour_of_week, daypart: cal.daypart, season: cal.season, weather: bandByHour.get(h * 3600) };
      const cond = conds.code(`${c.hourOfWeek}|${c.daypart}|${c.season}|${c.weather ?? ""}`);
      if (cond >= COND_SPACE) throw new Error(`more than ${COND_SPACE} distinct conditions; widen COND_SPACE`);
      info = { hour: nyHourDow(ts).hour, cond, c };
      byHour.set(h, info);
    }
    return info;
  };

  const stops = new Dict(), routes = new Dict(), segs = new Dict(), tracks = new Dict();

  /*
   * Runs and dwells come from one pass over the stop-to-stop sequence, the costliest query here:
   * a run is a departure or pass to the next arrival or pass, a dwell an arrival to the departure
   * from the same stop. Both arrive in time order, which is what the gated fit splits on.
   */
  const run = { ts: [] as number[], dt: [] as number[], route: [] as number[], stop: [] as number[], next: [] as number[], seg: [] as number[], track: [] as number[] };
  const dwl = { ts: [] as number[], dt: [] as number[], stop: [] as number[] };
  await eachRow(conn, `
    SELECT kind = 'arrive' AS is_dwell, ts, next_ts - ts, route, stop_id, next_stop, next_track FROM (${consecutive(STOP_KINDS)})
    WHERE NOT est AND NOT next_est AND (
      (kind IN ('depart', 'pass') AND next_kind IN ('arrive', 'pass') AND next_stop <> '' AND next_stop <> stop_id
        AND next_ts - ts > 10 AND next_ts - ts < 1800)
      OR (kind = 'arrive' AND next_kind = 'depart' AND next_stop = stop_id AND next_ts - ts >= 5 AND next_ts - ts < 900))
    ORDER BY ts, stop_id, next_stop, route, next_track, next_ts`, ([isDwell, ts, dt, route, stop, next, track]) => {
    if (isDwell) {
      dwl.ts.push(ts as number);
      dwl.dt.push(dt as number);
      dwl.stop.push(stops.code(stop as string));
      return;
    }
    run.ts.push(ts as number);
    run.dt.push(dt as number);
    run.route.push(routes.code(route as string));
    run.stop.push(stops.code(stop as string));
    run.next.push(stops.code(next as string));
    run.seg.push(segs.code(`${stop}>${next}`));
    run.track.push(track ? tracks.code(track as string) : -1);
  });
  const nRuns = run.ts.length;
  const runTime = statsBy(run.seg, run.dt, (k) => segs.names[k]);
  const runTimeHour = statsBy(run.seg.map((sg, i) => sg * 24 + hourInfo(run.ts[i]).hour), run.dt, (k) => `${segs.names[Math.floor(k / 24)]}@${k % 24}`);

  const prevByTrack: Record<string, Record<string, number>> = {};
  for (let i = 0; i < nRuns; i++) {
    if (run.track[i] < 0) continue;
    const k = `${routes.names[run.route[i]]}|${stops.names[run.next[i]]}|${tracks.names[run.track[i]]}`;
    const prev = stops.names[run.stop[i]];
    const counts = (prevByTrack[k] ??= {});
    counts[prev] = (counts[prev] ?? 0) + 1;
  }

  const nRoutes = routes.names.length;
  const runFit = gatedHierarchy(RUN_LEVELS, samplesOf(nRuns, (i) => run.dt[i], (i) => {
    const h = hourInfo(run.ts[i]);
    return [(run.seg[i] * nRoutes + run.route[i]) * COND_SPACE + h.cond,
      () => runKeys(routes.names[run.route[i]], stops.names[run.stop[i]], stops.names[run.next[i]], h.c)];
  }), 1); // "seg"

  const nDwells = dwl.ts.length;
  const dwell = statsBy(dwl.stop, dwl.dt, (k) => stops.names[k]);
  const dwellHour = statsBy(dwl.stop.map((st, i) => st * 24 + hourInfo(dwl.ts[i]).hour), dwl.dt, (k) => `${stops.names[Math.floor(k / 24)]}@${k % 24}`);
  const dwellFit = gatedHierarchy(DWELL_LEVELS, samplesOf(nDwells, (i) => dwl.dt[i], (i) => {
    const h = hourInfo(dwl.ts[i]);
    return [dwl.stop[i] * COND_SPACE + h.cond, () => dwellKeys(stops.names[dwl.stop[i]], h.c)];
  }), 1); // "stop"
  const runHier = runFit.hier, dwellHier = dwellFit.hier;
  const dwellMedians = Object.values(dwell).map((s) => s.p50);
  const dwellGlobal = dwellMedians.length >= 5 ? quantile(dwellMedians, 0.5) : 35;

  // --- Summaries that need no row in JS at all -----------------------------------------------
  const listStats = async (sql: string) => {
    const stats: Record<string, Stat> = {};
    let rows = 0;
    await eachRow(conn, sql, ([k, v]) => {
      stats[k as string] = stat(v as number[]);
      rows += (v as number[]).length;
    });
    return { stats, rows };
  };
  const { stats: approach, rows: nApproaches } = await listStats(`
    SELECT stop_id, list(next_ts - ts) FROM (${consecutive([...STOP_KINDS, "incoming"])})
    WHERE kind = 'incoming' AND next_kind = 'arrive' AND next_stop = stop_id
      AND NOT est AND NOT next_est AND next_ts - ts > 0 AND next_ts - ts < 600
    GROUP BY 1 HAVING count(*) >= 3`);
  // Arrival-to-arrival between consecutive arrivals of the same trip: observable on every feed.
  const { stats: a2a } = await listStats(`
    SELECT stop_id || '>' || next_stop, list(next_ts - ts) FROM (
      SELECT ts::DOUBLE AS ts, stop_id, (lead(ts) OVER w)::DOUBLE AS next_ts, lead(stop_id) OVER w AS next_stop
      FROM ev WHERE kind = 'arrive' AND NOT estimated WINDOW w AS (PARTITION BY trip_id ORDER BY ts, stop_id))
    WHERE next_stop <> '' AND next_stop <> stop_id AND next_ts - ts > 20 AND next_ts - ts < 1800
    GROUP BY 1 HAVING count(*) >= 3`);

  /*
   * ETA residuals: every observation joined to the actual (non-estimated) arrival at that stop,
   * counted straight into histograms.
   *
   * Residuals are counted into histograms rather than collected as rows, so that observations
   * summarised months ago count exactly as much as this morning's — which also lets DuckDB do the
   * counting and return a few hundred buckets a cell instead of twenty million observations.
   *
   * Every level the lookup backs off through gets its own histogram: a coarse cell cannot be
   * recovered from the fine ones once the rows are gone, so `route:` and `all|` are accumulated
   * alongside `seg:` and `orig:` rather than derived.
   */
  const horizon = `CASE ${HORIZONS.map((h, i) => `WHEN eo.predicted::DOUBLE - eo.obs_ts::DOUBLE < ${h} THEN 'h${i}'`).join(" ")} ELSE 'h${HORIZONS.length}' END`;
  const hists = new Map<string, Histogram>();
  const into = (cell: string, bucket: number, n: number) => {
    const h = hists.get(cell) ?? hists.set(cell, new Map()).get(cell)!;
    h.set(bucket, (h.get(bucket) ?? 0) + n);
  };
  let cleanObs = 0;
  await eachRow(conn, `
    WITH o AS MATERIALIZED (
      SELECT eo.prev_stop, eo.stop_id, eo.route, ${horizon} AS b,
             floor((ev.ts::DOUBLE - eo.predicted::DOUBLE) / ${BUCKET_S}) AS bucket
      FROM eo JOIN ev ON ev.trip_id = eo.trip_id AND ev.stop_id = eo.stop_id AND ev.kind = 'arrive' AND NOT ev.estimated
      WHERE ev.ts >= eo.obs_ts - 5 AND eo.predicted - eo.obs_ts >= -30 AND abs(ev.ts::DOUBLE - eo.predicted::DOUBLE) < 900)
    SELECT cell, bucket, count(*)::DOUBLE FROM (
      SELECT CASE WHEN coalesce(prev_stop, '') <> '' THEN 'seg:' || prev_stop || '>' || stop_id ELSE 'orig:' || stop_id END || '|' || b AS cell, bucket FROM o
      UNION ALL SELECT 'route:' || route || '|' || b, bucket FROM o
      UNION ALL SELECT 'all|' || b, bucket FROM o)
    GROUP BY 1, 2`, ([cell, bucket, n]) => {
    into(cell as string, bucket as number, n as number);
    if ((cell as string).startsWith("all|")) cleanObs += n as number;
  });

  // Everything already summarised. These are the months the raw rows no longer exist for.
  let rolledObs = 0;
  const rollupDir = join(REC_DIR, "rollups");
  const rollupGlob = join(rollupDir, "*.parquet");
  if (existsSync(rollupDir) && readdirSync(rollupDir).some((f) => f.endsWith(".parquet"))) {
    await eachRow(conn, `SELECT cell, bucket::DOUBLE, sum(n)::DOUBLE FROM read_parquet('${rollupGlob}', union_by_name=true)
       WHERE kind = 'resid' GROUP BY 1, 2`, ([cell, bucket, n]) => {
      into(cell as string, bucket as number, n as number);
      rolledObs += n as number;
    });
  }

  const residual: Record<string, ResidualStat> = {};
  for (const [k, h] of hists) residual[k] = statFromHistogram(h);

  const nEvents = Number((await conn.runAndReadAll(`SELECT count(*) AS n FROM ev`)).getRowObjects()[0].n);
  const window = (await conn.runAndReadAll(`SELECT min(ts) AS a, max(ts) AS b FROM ev`)).getRowObjects()[0];
  const tables: TimingTables = {
    generatedAt: new Date().toISOString(),
    window: { from: new Date(Number(window.a) * 1000).toISOString(), to: new Date(Number(window.b) * 1000).toISOString() },
    samples: { events: nEvents, etaObs: cleanObs + rolledObs },
    runHier, dwellHier, hierGate: { run: runFit.gate, dwell: dwellFit.gate },
    runTime, runTimeHour, a2a, dwellGlobal, dwell, dwellHour, approach, residual, prevByTrack,
  };
  mkdirSync(join(out, ".."), { recursive: true });
  // Atomic: the poller watches the live tables and reloads them, so they must never be half-written.
  writeFileSync(`${out}.tmp`, JSON.stringify(tables));
  renameSync(`${out}.tmp`, out);

  console.log(`events ${nEvents} · runs ${nRuns} · dwells ${nDwells} · approaches ${nApproaches} · eta obs ${cleanObs}`);
  const rs = hierarchySize(runHier), ds = hierarchySize(dwellHier);
  console.log(`run hierarchy: ${rs.nodes} cells ${JSON.stringify(rs.byLevel)} (prior ${runHier.prior.v}s over ${runHier.prior.n})`);
  console.log(`dwell hierarchy: ${ds.nodes} cells ${JSON.stringify(ds.byLevel)} (prior ${dwellHier.prior.v}s over ${dwellHier.prior.n})`);
  const g = (n: string, x: { active: boolean; k: number; shape?: string; flatMae: number; hierMae: number; testRows: number }) =>
    `${n}: ${x.active ? "ACTIVE" : "off"} (${x.shape}, ${x.hierMae.toFixed(1)}s vs flat ${x.flatMae.toFixed(1)}s on ${x.testRows} held out)`;
  console.log(g("run conditioning", runFit.gate));
  console.log(g("dwell conditioning", dwellFit.gate));
  console.log(`weather hours joined: ${bandByHour.size}`);
  if (rolledObs) console.log(`residuals include ${rolledObs.toLocaleString()} observations from summarised days`);
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
