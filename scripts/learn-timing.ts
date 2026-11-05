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
import type { DuckDBConnection, DuckDBVector } from "@duckdb/node-api";
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

/** A typed array sorts numerically with no comparator; each group is sorted once for all three. */
const ascending = (xs: ArrayLike<number>) => Float64Array.from(xs).sort();
const at = (sorted: ArrayLike<number>, p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
const quantile = (xs: number[], p: number) => at(ascending(xs), p);
const stat = (xs: ArrayLike<number>): Stat => {
  const s = ascending(xs);
  return { p50: at(s, 0.5), p16: at(s, 0.16), p84: at(s, 0.84), n: xs.length };
};

/**
 * Streams a query a chunk at a time and hands over its columns, so no result is held whole in
 * memory and no row is built as an object: each value is read straight from DuckDB's vector.
 */
async function eachChunk(conn: DuckDBConnection, sql: string, fn: (columns: DuckDBVector[], rows: number) => void): Promise<void> {
  const result = await conn.stream(sql);
  for (;;) {
    const chunk = await result.fetchChunk();
    if (!chunk || chunk.rowCount === 0) return;
    fn(Array.from({ length: chunk.columnCount }, (_, i) => chunk.getColumnVector(i)), chunk.rowCount);
  }
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
 * One sample per row, with rows that have the same keys sharing one array: `id` names a row's
 * keys as a number and `keys` builds them the first time that number is seen. Ten million samples
 * then point at a few hundred thousand arrays instead of building five strings each.
 */
function samplesOf(n: number, value: (i: number) => number, id: (i: number) => number, keys: (i: number) => Sample["keys"]): Sample[] {
  const shared = new Map<number, Sample["keys"]>();
  const out: Sample[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const k = id(i);
    let ks = shared.get(k);
    if (!ks) {
      ks = keys(i);
      shared.set(k, ks);
    }
    out[i] = { value: value(i), keys: ks };
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
   * Stops, routes and tracks as small integers, numbered in name order so that sorting by the
   * number sorts exactly as sorting by the name did. Ten million rows of codes cross into JS as
   * numbers; the same rows as strings spent a third of the learner's time being decoded.
   */
  const dict = async (table: string, expr: string, where: string) => {
    await conn.run(`CREATE TEMP TABLE ${table} AS
      SELECT name, (row_number() OVER (ORDER BY name) - 1)::INTEGER AS id FROM (SELECT DISTINCT ${expr} AS name FROM ev WHERE ${where})`);
    return ((await conn.runAndReadAll(`SELECT name FROM ${table} ORDER BY id`)).getRowsJS() as [string][]).map(([n]) => n);
  };
  const stops = await dict("stop_dict", "stop_id", "stop_id IS NOT NULL");
  const routes = await dict("route_dict", "coalesce(route, 'null')", "true");
  // A blank track is kept as a name so that it sorts where it always did, first; it is no track.
  const tracks = await dict("track_dict", "track", "track IS NOT NULL");
  const noTrack = tracks.indexOf("");

  // Weather is recorded hourly and joined here. It only started being recorded when the
  // context recorder first ran, so early history simply has no weather level — the hierarchy
  // skips levels it has nothing for.
  const bandByHour = new Map<number, WeatherBand>();
  try {
    const rows = (await conn.runAndReadAll(`SELECT hour::DOUBLE, precip_mm, snow_cm, code FROM read_parquet('${parquetGlob("weather")}', union_by_name=true)`)).getRowsJS();
    for (const [hour, precip_mm, snow_cm, code] of rows) bandByHour.set(hour as number, band({ precip_mm, snow_cm, code } as Parameters<typeof band>[0]));
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

  /*
   * Runs, dwells and approaches, from one pass over each trip's events — the costliest query here,
   * and it used to be made twice. A run is a departure or pass to the next arrival or pass, a dwell
   * an arrival to the departure from the same stop, an approach an `incoming` to the arrival it
   * announced.
   *
   * Runs and dwells pair stop events with each other and skip `incoming`, so a departure pairs with
   * the following arrival even when an approach event sits between them; approaches pair with the
   * very next event. Both come from the same window: `n3` is the next row that is not `incoming`,
   * carried as a struct because a struct is never null when its fields are — so `IGNORE NULLS`
   * skips exactly the approach events and nothing else.
   *
   * Two events of one trip can share a second, and the feed repeats some outright; everything else
   * in the row breaks the tie, so that two builds over the same history pair the same events and
   * sort them the same way — the gate compares tables, and a comparison is only as good as its
   * inputs are repeatable. The coalesces keep the JS truthiness these filters were first written
   * in: a file recorded before `estimated` existed reads as not estimated.
   */
  const RUN = 0, DWELL = 1, APPROACH = 2;
  const run = { ts: [] as number[], dt: [] as number[], route: [] as number[], stop: [] as number[], next: [] as number[], seg: [] as number[], track: [] as number[] };
  const dwl = { ts: [] as number[], dt: [] as number[], stop: [] as number[] };
  const appr = { dt: [] as number[], stop: [] as number[] };
  const segOf = new Map<number, number>();
  const segNames: string[] = [];
  if (stops.length >= 1 << 16) throw new Error(`${stops.length} stops do not fit a segment code`);
  await eachChunk(conn, `
    WITH s AS (
      SELECT ts::DOUBLE AS ts, coalesce(route, 'null') AS route, stop_id, kind, coalesce(estimated, false) AS est,
             (lead(ts) OVER w)::DOUBLE AS nts, lead(stop_id) OVER w AS ns, lead(kind) OVER w AS nk,
             coalesce(lead(estimated) OVER w, false) AS ne,
             lead(CASE WHEN kind <> 'incoming' THEN
                    {'ts': ts::DOUBLE, 'stop': stop_id, 'kind': kind, 'track': track, 'est': coalesce(estimated, false)} END
                  IGNORE NULLS) OVER w AS n3
      FROM ev WHERE kind IN ('arrive', 'depart', 'pass', 'incoming')
      WINDOW w AS (PARTITION BY trip_id ORDER BY ts, CASE kind WHEN 'arrive' THEN 0 WHEN 'incoming' THEN 0 ELSE 1 END, stop_id, kind, track, estimated)
    ), p AS (
      SELECT CASE
               WHEN kind IN ('depart', 'pass') AND n3.kind IN ('arrive', 'pass') AND n3.stop <> '' AND n3.stop <> stop_id
                    AND NOT est AND NOT n3.est AND n3.ts - ts > 10 AND n3.ts - ts < 1800 THEN ${RUN}
               WHEN kind = 'arrive' AND n3.kind = 'depart' AND n3.stop = stop_id
                    AND NOT est AND NOT n3.est AND n3.ts - ts >= 5 AND n3.ts - ts < 900 THEN ${DWELL}
               WHEN kind = 'incoming' AND nk = 'arrive' AND ns = stop_id
                    AND NOT est AND NOT ne AND nts - ts > 0 AND nts - ts < 600 THEN ${APPROACH}
             END AS what,
             ts, CASE WHEN kind = 'incoming' THEN nts ELSE n3.ts END AS next_ts, route, stop_id,
             CASE WHEN kind = 'incoming' THEN ns ELSE n3.stop END AS next_stop, n3.track AS next_track
      FROM s
    )
    SELECT what::INTEGER, ts, next_ts - ts, r.id, st.id, coalesce(nx.id, -1), coalesce(tr.id, -1)
    FROM p JOIN route_dict r ON r.name = p.route JOIN stop_dict st ON st.name = p.stop_id
      LEFT JOIN stop_dict nx ON nx.name = p.next_stop LEFT JOIN track_dict tr ON tr.name = p.next_track
    WHERE what IS NOT NULL
    ORDER BY ts, st.id, nx.id, r.id, tr.id, next_ts`, (c, n) => {
    const [what, ts, dt, route, stop, next, track] = c;
    for (let i = 0; i < n; i++) {
      const w = what.getItem(i) as number;
      const st = stop.getItem(i) as number;
      if (w === APPROACH) {
        appr.dt.push(dt.getItem(i) as number);
        appr.stop.push(st);
        continue;
      }
      if (w === DWELL) {
        dwl.ts.push(ts.getItem(i) as number);
        dwl.dt.push(dt.getItem(i) as number);
        dwl.stop.push(st);
        continue;
      }
      const nx = next.getItem(i) as number;
      const id = st * 65536 + nx;
      let sg = segOf.get(id);
      if (sg === undefined) {
        sg = segNames.length;
        segOf.set(id, sg);
        segNames.push(`${stops[st]}>${stops[nx]}`);
      }
      run.ts.push(ts.getItem(i) as number);
      run.dt.push(dt.getItem(i) as number);
      run.route.push(route.getItem(i) as number);
      run.stop.push(st);
      run.next.push(nx);
      run.seg.push(sg);
      const tk = track.getItem(i) as number;
      run.track.push(tk === noTrack ? -1 : tk);
    }
  });

  /*
   * The two remaining queries need nothing from JS, so they run on their own connections while JS
   * fits the hierarchies — DuckDB works on its own threads, and the fit was the learner's longest
   * stretch with DuckDB idle.
   */
  const side = (sql: string) => db.connect().then(async (c) => {
    try {
      return (await c.runAndReadAll(sql)).getRowsJS();
    } finally {
      c.closeSync();
    }
  });
  // Arrival-to-arrival between consecutive arrivals of the same trip: observable on every feed.
  const a2aRows = side(`
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
  const residRows = side(`
    WITH o AS MATERIALIZED (
      SELECT eo.prev_stop, eo.stop_id, eo.route, ${horizon} AS b,
             floor((ev.ts::DOUBLE - eo.predicted::DOUBLE) / ${BUCKET_S}) AS bucket
      FROM eo JOIN ev ON ev.trip_id = eo.trip_id AND ev.stop_id = eo.stop_id AND ev.kind = 'arrive' AND NOT ev.estimated
      WHERE ev.ts >= eo.obs_ts - 5 AND eo.predicted - eo.obs_ts >= -30 AND abs(ev.ts::DOUBLE - eo.predicted::DOUBLE) < 900)
    SELECT cell, bucket, count(*)::DOUBLE FROM (
      SELECT CASE WHEN coalesce(prev_stop, '') <> '' THEN 'seg:' || prev_stop || '>' || stop_id ELSE 'orig:' || stop_id END || '|' || b AS cell, bucket FROM o
      UNION ALL SELECT 'route:' || route || '|' || b, bucket FROM o
      UNION ALL SELECT 'all|' || b, bucket FROM o)
    GROUP BY 1, 2`);
  // Everything already summarised. These are the months the raw rows no longer exist for.
  const rollupDir = join(REC_DIR, "rollups");
  const rolledRows = existsSync(rollupDir) && readdirSync(rollupDir).some((f) => f.endsWith(".parquet"))
    ? side(`SELECT cell, bucket::DOUBLE, sum(n)::DOUBLE FROM read_parquet('${join(rollupDir, "*.parquet")}', union_by_name=true)
            WHERE kind = 'resid' GROUP BY 1, 2`)
    : Promise.resolve([]);
  // Settled now, so that a failure is not an unhandled rejection while the fit holds the thread.
  const settled = Promise.allSettled([a2aRows, residRows, rolledRows]);

  // --- The fits -----------------------------------------------------------------------------
  const nRuns = run.ts.length;
  const runTime = statsBy(run.seg, run.dt, (k) => segNames[k]);
  const runTimeHour = statsBy(run.seg.map((sg, i) => sg * 24 + hourInfo(run.ts[i]).hour), run.dt, (k) => `${segNames[Math.floor(k / 24)]}@${k % 24}`);

  const prevByTrack: Record<string, Record<string, number>> = {};
  for (let i = 0; i < nRuns; i++) {
    if (run.track[i] < 0) continue;
    const k = `${routes[run.route[i]]}|${stops[run.next[i]]}|${tracks[run.track[i]]}`;
    const prev = stops[run.stop[i]];
    const counts = (prevByTrack[k] ??= {});
    counts[prev] = (counts[prev] ?? 0) + 1;
  }

  const nRoutes = routes.length;
  const runFit = gatedHierarchy(RUN_LEVELS, samplesOf(nRuns, (i) => run.dt[i],
    (i) => (run.seg[i] * nRoutes + run.route[i]) * COND_SPACE + hourInfo(run.ts[i]).cond,
    (i) => runKeys(routes[run.route[i]], stops[run.stop[i]], stops[run.next[i]], hourInfo(run.ts[i]).c)), 1); // "seg"

  const nDwells = dwl.ts.length;
  const dwell = statsBy(dwl.stop, dwl.dt, (k) => stops[k]);
  const dwellHour = statsBy(dwl.stop.map((st, i) => st * 24 + hourInfo(dwl.ts[i]).hour), dwl.dt, (k) => `${stops[Math.floor(k / 24)]}@${k % 24}`);
  const dwellFit = gatedHierarchy(DWELL_LEVELS, samplesOf(nDwells, (i) => dwl.dt[i],
    (i) => dwl.stop[i] * COND_SPACE + hourInfo(dwl.ts[i]).cond,
    (i) => dwellKeys(stops[dwl.stop[i]], hourInfo(dwl.ts[i]).c)), 1); // "stop"
  const runHier = runFit.hier, dwellHier = dwellFit.hier;
  const dwellMedians = Object.values(dwell).map((s) => s.p50);
  const dwellGlobal = dwellMedians.length >= 5 ? quantile(dwellMedians, 0.5) : 35;
  const approach = statsBy(appr.stop, appr.dt, (k) => stops[k]);
  const nApproaches = appr.dt.length;

  // --- What DuckDB was doing meanwhile ------------------------------------------------------
  const [a2aDone, residDone, rolledDone] = await settled;
  for (const r of [a2aDone, residDone, rolledDone]) if (r.status === "rejected") throw r.reason;
  const value = <T,>(r: PromiseSettledResult<T>) => (r as PromiseFulfilledResult<T>).value;

  const a2a: Record<string, Stat> = {};
  for (const [k, v] of value(a2aDone)) a2a[k as string] = stat(v as number[]);

  const hists = new Map<string, Histogram>();
  const into = (cell: string, bucket: number, n: number) => {
    const h = hists.get(cell) ?? hists.set(cell, new Map()).get(cell)!;
    h.set(bucket, (h.get(bucket) ?? 0) + n);
  };
  let cleanObs = 0;
  for (const [cell, bucket, n] of value(residDone)) {
    into(cell as string, bucket as number, n as number);
    if ((cell as string).startsWith("all|")) cleanObs += n as number;
  }
  let rolledObs = 0;
  for (const [cell, bucket, n] of value(rolledDone)) {
    into(cell as string, bucket as number, n as number);
    rolledObs += n as number;
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
