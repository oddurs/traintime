/**
 * Turn old observations into the statistics that were going to be learned from them anyway.
 *
 * ETA observations arrive at about 16 MB a day. Kept as rows, a year is 5.8 GB against a 5 GB
 * volume — so the history that would let the engine learn about seasons, holidays and weather is
 * exactly the history that expires before a year of it exists. Rolled into per-cell histograms it
 * is a few hundred megabytes, merges by addition, and answers the same questions.
 *
 * Only complete days well behind the present are rolled up, and the raw rows are only removed once
 * their rollup is safely on disk — the same rename-then-delete discipline compaction learned the
 * hard way.
 */
import { existsSync, mkdirSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { DuckDBConnection } from "@duckdb/node-api";
import { HORIZONS } from "../../src/lib/timing";
import { BUCKET_S } from "../../src/lib/histogram";
import { REC_DIR } from "./recorder";
import { DEFAULT_POLICY, summarisedDays, type RetentionPolicy } from "./retention";

const DAY = 86_400;

/**
 * How old a day must be before it is summarised — which has to be strictly inside the window the
 * raw observations are kept for, and was not.
 *
 * This was a constant 21 against an observation window of 14, so every day was deleted by `prune`
 * a full week before it became eligible, and the two numbers could never both be satisfied. The
 * summariser was not slow or broken: it was unreachable. `/health` said `summarised: {days: 0}`,
 * which reads as "there was nothing to summarise", and the learner's cold-history path — the one
 * that is supposed to carry the months whose rows no longer exist — was always going to be empty.
 *
 * It was reachable once. The window was 30 days until the retention tightening in 81e34f1 cut it
 * to 14 to buy disk back for ticks, and nothing connected the two numbers, so one of them moved
 * and the other did not. Deriving it from the policy is the fix: there is no pair of values a
 * future tightening can leave in this state.
 */
export function rollupAfterDays(policy: RetentionPolicy = DEFAULT_POLICY): number {
  // One day of margin. The pass runs hourly, so that is twenty-four chances to summarise a day
  // before it is pruned — enough that a restart or a failed pass cannot cost the day.
  const latest = Math.max(1, policy.obsDays - 1);
  const configured = process.env.ROLLUP_AFTER_DAYS;
  if (configured === undefined) return latest;
  const n = Number(configured);
  if (!Number.isFinite(n) || n < 1) {
    console.warn(`[rollup] ROLLUP_AFTER_DAYS=${configured} is not a positive number; using ${latest}`);
    return latest;
  }
  if (n > latest) {
    console.warn(`[rollup] ROLLUP_AFTER_DAYS=${n} is outside the ${policy.obsDays}-day observation ` +
      `window, so nothing would ever be summarised; using ${latest}`);
    return latest;
  }
  return n;
}

const dir = (name: string) => join(REC_DIR, name);
const dayOf = (file: string) => /(\d{4}-\d{2}-\d{2})/.exec(file)?.[1] ?? null;

/** The horizon bucket, as SQL, so a day never has to be pulled into memory to be summarised. */
function horizonSql(expr: string): string {
  let out = `CASE`;
  HORIZONS.forEach((h, i) => { out += ` WHEN ${expr} < ${h} THEN 'h${i}'`; });
  return `${out} ELSE 'h${HORIZONS.length}' END`;
}

/**
 * Every level the residual lookup backs off through gets its own rows, because a histogram can
 * only be merged with one for the same cell — the coarse levels are not derivable from the fine
 * ones once the rows are gone.
 */
const KEYS = [
  `CASE WHEN prev_stop IS NOT NULL THEN 'seg:' || prev_stop || '>' || stop_id || '|' || hb END`,
  `CASE WHEN prev_stop IS NULL THEN 'orig:' || stop_id || '|' || hb END`,
  `'route:' || route || '|' || hb`,
  `'all|' || hb`,
];

export interface RollupResult { days: string[]; cells: number; freedRows: number }

/**
 * Summarise every complete day older than the cutoff that has not been summarised already, then
 * drop the raw files for those days.
 */
export async function rollup(
  conn: DuckDBConnection,
  now = Math.floor(Date.now() / 1000),
  policy: RetentionPolicy = DEFAULT_POLICY,
): Promise<RollupResult> {
  const obsDir = dir("eta_obs"), outDir = dir("rollups");
  if (!existsSync(obsDir)) return { days: [], cells: 0, freedRows: 0 };
  mkdirSync(outDir, { recursive: true });

  // Shared with prune, which holds an unsummarised day past its window rather than delete it.
  const done = summarisedDays();

  const cutoff = now - rollupAfterDays(policy) * DAY;
  const byDay = new Map<string, string[]>();
  for (const f of readdirSync(obsDir)) {
    if (!f.endsWith(".parquet")) continue;
    const d = dayOf(f);
    if (!d || done.has(d)) continue;
    // Whole days only, and only once the day is comfortably behind us.
    if (Date.parse(`${d}T23:59:59Z`) / 1000 > cutoff) continue;
    (byDay.get(d) ?? byDay.set(d, []).get(d)!).push(join(obsDir, f));
  }
  if (!byDay.size) return { days: [], cells: 0, freedRows: 0 };

  const evGlob = join(dir("events"), "*.parquet");
  const result: RollupResult = { days: [], cells: 0, freedRows: 0 };

  for (const [day, files] of byDay) {
    const list = files.map((f) => `'${f}'`).join(", ");
    const tmp = join(outDir, `${day}.tmp.parquet`);
    const out = join(outDir, `${day}.parquet`);
    // The residual is the same join the learner does; bucketed and counted rather than returned.
    const sql = `
      WITH obs AS (
        SELECT eo.obs_ts, eo.predicted, eo.prev_stop, eo.route, eo.stop_id, ev.ts AS actual
        FROM read_parquet([${list}], union_by_name=true) eo
        JOIN read_parquet('${evGlob}', union_by_name=true) ev
          ON ev.trip_id = eo.trip_id AND ev.stop_id = eo.stop_id AND ev.kind = 'arrive' AND NOT ev.estimated
        WHERE ev.ts >= eo.obs_ts - 5 AND eo.predicted - eo.obs_ts >= -30
          AND abs(ev.ts - eo.predicted) < 900
      ),
      tagged AS (
        SELECT *, ${horizonSql("predicted - obs_ts")} AS hb,
               CAST(floor((actual - predicted) / ${BUCKET_S}) AS INTEGER) AS bucket
        FROM obs
      ),
      keyed AS (${KEYS.map((k) => `SELECT ${k} AS cell, bucket FROM tagged`).join(" UNION ALL ")})
      SELECT 'resid' AS kind, cell, bucket, count(*) AS n, '${day}' AS day
      FROM keyed WHERE cell IS NOT NULL GROUP BY 1, 2, 3`;
    await conn.run(`COPY (${sql}) TO '${tmp}' (FORMAT PARQUET, COMPRESSION ZSTD)`);
    // Atomic: after this the rollup is the record, and only then are the rows expendable.
    renameSync(tmp, out);
    const cells = (await conn.runAndReadAll(`SELECT count(*) AS c FROM read_parquet('${out}')`)).getRowObjects()[0] as { c: bigint };
    result.cells += Number(cells.c);
    for (const f of files) { try { unlinkSync(f); result.freedRows++; } catch { /* already gone */ } }
    result.days.push(day);
  }
  return result;
}

/** What has been summarised, for /health to report. */
export function rollupStatus(): { days: number; from: string | null; to: string | null } {
  const outDir = dir("rollups");
  if (!existsSync(outDir)) return { days: 0, from: null, to: null };
  const days = readdirSync(outDir).map(dayOf).filter((d): d is string => !!d).sort();
  return { days: days.length, from: days[0] ?? null, to: days[days.length - 1] ?? null };
}
