/**
 * Keeping a year of data on a small disk. Raw ticks are the bulk and the least reusable once
 * events have been derived from them, so they get a short window; events and ETA observations
 * are what the timing tables are learned from, so they are kept far longer. Many small Parquet
 * files also make every read slower, so old ones are merged into daily files.
 */
import { existsSync, readdirSync, statSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DuckDBConnection } from "@duckdb/node-api";
import { REC_DIR, TABLES } from "./recorder";

export interface RetentionPolicy {
  /** Days of raw protobuf ticks to keep. */
  ticksDays: number;
  /** Days of derived events and observations to keep. */
  eventsDays: number;
  /** Files older than this are candidates for merging into a daily file. */
  compactAfterHours: number;
}

export const DEFAULT_POLICY: RetentionPolicy = {
  ticksDays: Number(process.env.TICKS_RETENTION_DAYS ?? 4),
  eventsDays: Number(process.env.EVENTS_RETENTION_DAYS ?? 120),
  compactAfterHours: 2,
};

const DAY_MS = 86_400_000;
const stampOf = (file: string) => file.replace(/\.parquet$/, "").replace(/^rebuilt-/, "").replace(/^daily-/, "");
const isDaily = (file: string) => file.startsWith("daily-");

/**
 * When a file's contents are from, in epoch ms, or null if the name does not say.
 *
 * Parsed strictly rather than massaged into something Date.parse will accept: "2026-08-31" fed
 * through a loose conversion becomes "2026:08:31", which Date.parse reads as the first of January
 * at 08:31 — eight months stale — and the file is deleted the moment after compaction wrote it.
 * Names are produced from toISOString(), so they are UTC.
 */
export function stampTime(file: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2})-(\d{2})-(\d{2}))?$/.exec(stampOf(file));
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m;
  return Date.UTC(+y, +mo - 1, +d, +(h ?? 0), +(mi ?? 0), +(se ?? 0));
}

/**
 * Remove partial files left behind by an interrupted write. DuckDB stages a COPY as `tmp_...`
 * in the target directory, so a process killed mid-flush leaves something the *.parquet glob
 * will happily try to read — and then every query against that table fails.
 */
export function cleanTemp(): number {
  let removed = 0;
  for (const table of TABLES) {
    const dir = join(REC_DIR, table);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.startsWith("tmp_") && !f.endsWith(".tmp.parquet")) continue;
      try { unlinkSync(join(dir, f)); removed++; } catch {}
    }
  }
  return removed;
}

export function diskUsage(): { bytes: number; files: number; byTable: Record<string, number> } {
  let bytes = 0, files = 0;
  const byTable: Record<string, number> = {};
  for (const table of TABLES) {
    const dir = join(REC_DIR, table);
    if (!existsSync(dir)) continue;
    let t = 0;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".parquet")) continue;
      t += statSync(join(dir, f)).size;
      files++;
    }
    byTable[table] = t;
    bytes += t;
  }
  return { bytes, files, byTable };
}

/** Delete Parquet files whose day is outside the retention window. */
export function prune(policy: RetentionPolicy = DEFAULT_POLICY): Record<string, number> {
  const removed: Record<string, number> = {};
  const now = Date.now();
  for (const table of TABLES) {
    const dir = join(REC_DIR, table);
    if (!existsSync(dir)) continue;
    const days = table === "ticks" ? policy.ticksDays : policy.eventsDays;
    const cutoff = now - days * DAY_MS;
    let n = 0;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".parquet")) continue;
      const full = join(dir, f);
      const named = stampTime(f);
      const mtime = statSync(full).mtimeMs;
      // A file is only old if BOTH its name and its mtime say so. Recently written files are
      // never deleted, whatever their name claims — losing recordings is unrecoverable, and a
      // parsing mistake must not be able to cause it.
      if (mtime >= cutoff) continue;
      if (named !== null && named >= cutoff) continue;
      unlinkSync(full);
      n++;
    }
    if (n) removed[table] = n;
  }
  return removed;
}

/**
 * Merge the many small flush files for a table into one file per day. Only files older than
 * `compactAfterHours` are touched, so nothing being written right now is disturbed.
 */
export async function compact(conn: DuckDBConnection, policy: RetentionPolicy = DEFAULT_POLICY): Promise<Record<string, number>> {
  const merged: Record<string, number> = {};
  const cutoff = Date.now() - policy.compactAfterHours * 3_600_000;
  for (const table of TABLES) {
    const dir = join(REC_DIR, table);
    if (!existsSync(dir)) continue;
    mkdirSync(dir, { recursive: true });
    const byDay = new Map<string, string[]>();
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".parquet") || isDaily(f)) continue;
      const full = join(dir, f);
      if (statSync(full).mtimeMs > cutoff) continue;
      const day = stampOf(f).slice(0, 10);
      (byDay.get(day) ?? byDay.set(day, []).get(day)!).push(full);
    }
    for (const [day, files] of byDay) {
      if (files.length < 2) continue;
      const target = join(dir, `daily-${day}.parquet`);
      const sources = [...files, ...(existsSync(target) ? [target] : [])];
      const list = sources.map((f) => `'${f}'`).join(", ");
      const tmp = join(dir, `daily-${day}.tmp.parquet`);
      await conn.run(`COPY (SELECT * FROM read_parquet([${list}], union_by_name=true)) TO '${tmp}' (FORMAT PARQUET, COMPRESSION ZSTD)`);
      for (const f of sources) unlinkSync(f);
      const { renameSync } = await import("node:fs");
      renameSync(tmp, target);
      merged[table] = (merged[table] ?? 0) + files.length;
    }
  }
  return merged;
}
