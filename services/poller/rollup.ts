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

/** Days of raw observations to keep. The model trains on these; the tables can use the rollups. */
export const ROLLUP_AFTER_DAYS = Number(process.env.ROLLUP_AFTER_DAYS ?? 21);
const DAY = 86_400;

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
export async function rollup(conn: DuckDBConnection, now = Math.floor(Date.now() / 1000)): Promise<RollupResult> {
  const obsDir = dir("eta_obs"), outDir = dir("rollups");
  if (!existsSync(obsDir)) return { days: [], cells: 0, freedRows: 0 };
  mkdirSync(outDir, { recursive: true });

  const done = new Set<string>();
  for (const f of readdirSync(outDir)) { const d = dayOf(f); if (d) done.add(d); }

  const cutoff = now - ROLLUP_AFTER_DAYS * DAY;
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
