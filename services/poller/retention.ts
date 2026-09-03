/**
 * Keeping a year of data on a small disk. Raw ticks are the bulk and the least reusable once
 * events have been derived from them, so they get a short window; events and ETA observations
 * are what the timing tables are learned from, so they are kept far longer. Many small Parquet
 * files also make every read slower, so old ones are merged into daily files.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { DuckDBConnection } from "@duckdb/node-api";
import { REC_DIR, TABLES } from "./recorder";

export interface RetentionPolicy {
  /** Days of raw protobuf ticks to keep. */
  ticksDays: number;
  /** Days of derived events to keep. */
  eventsDays: number;
  /**
   * Days of raw ETA observations to keep. Shorter than events on purpose: they are five times the
   * volume, the residual tables read them through summaries once they age out, and only the
   * offline model wants them as rows.
   */
  obsDays: number;
  /** Files older than this are candidates for merging into a daily file. */
  compactAfterHours: number;
  /**
   * A hard ceiling on total storage. Age alone does not guarantee a volume never fills — a
   * busier day, a longer outage backlog or a change of feed size can all push past the estimate
   * — so the oldest raw ticks are dropped until the footprint is back under budget. Derived
   * events are never touched by this: they are small, and they are what the models learn from.
   */
  budgetBytes: number;
  /**
   * How much room to leave on the volume, whatever the budget says.
   *
   * A budget is a promise about this directory and says nothing about the disk it sits on. Three
   * days of ticks is two gigabytes, which is within budget and entirely correct — and on a laptop
   * that is nearly full it is still two gigabytes that something else needed. Recording a city's
   * trains is worth less than the machine continuing to work, so when the volume runs low the
   * oldest ticks go regardless of their age or the budget.
   */
  freeFloorBytes: number;
}

export const DEFAULT_POLICY: RetentionPolicy = {
  ticksDays: Number(process.env.TICKS_RETENTION_DAYS ?? 3),
  eventsDays: Number(process.env.EVENTS_RETENTION_DAYS ?? 400),
  obsDays: Number(process.env.OBS_RETENTION_DAYS ?? 30),
  compactAfterHours: 2,
  budgetBytes: Number(process.env.DISK_BUDGET_BYTES ?? 3_000_000_000),
  freeFloorBytes: Number(process.env.DISK_FREE_FLOOR_BYTES ?? 2_000_000_000),
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

/**
 * A merge that can safely be repeated. If a crash leaves the sources in place after the merged
 * file has landed, the next pass reads both and must not double-count what it already has.
 */
function dedupe(table: (typeof TABLES)[number], read: string): string {
  switch (table) {
    case "ticks":
      return `SELECT * FROM ${read} QUALIFY row_number() OVER (PARTITION BY feed, ts ORDER BY fetched_at) = 1`;
    case "trips":
      return `SELECT * FROM ${read} QUALIFY row_number() OVER (PARTITION BY trip_id ORDER BY last_seen DESC) = 1`;
    case "weather":
    case "calendar":
      return `SELECT * FROM ${read} QUALIFY row_number() OVER (PARTITION BY hour ORDER BY hour) = 1`;
    default:
      // Events and observations are fully described by their columns.
      return `SELECT DISTINCT * FROM ${read}`;
  }
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
    // Observations are only kept as long as the model trains on them; beyond that the rollups
    // carry what the tables need, in a fraction of the space. Events stay: they are small, and
    // run times, dwells and approaches are derived from their ordering rather than from counts.
    const days = table === "ticks" ? policy.ticksDays : table === "eta_obs" ? policy.obsDays : policy.eventsDays;
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
 * Drop the oldest raw ticks until total storage is back under budget. Ticks are the bulk and the
 * least valuable once events have been derived from them, so they are the right thing to give up.
 */
/**
 * How much room is left on the volume this directory lives on, in bytes.
 *
 * `statfs` is not in node:fs, and shelling out to `df` for a number that is only ever compared
 * with a threshold is not worth the process. Absent an answer the caller is told nothing is
 * known, and falls back to the budget alone.
 */
export function freeSpace(dir: string = REC_DIR): number | null {
  try {
    const out = execFileSync("df", ["-k", dir], { encoding: "utf8", timeout: 2000 });
    const line = out.trim().split("\n").pop() ?? "";
    const kb = Number(line.split(/\s+/)[3]);
    return Number.isFinite(kb) ? kb * 1024 : null;
  } catch {
    return null;
  }
}

export function enforceBudget(
  policy: RetentionPolicy = DEFAULT_POLICY,
  /** Overridable so this can be exercised against a scratch directory. */
  opts: { ticksDir?: string; totalBytes?: number; freeBytes?: number | null } = {},
): { removed: number; freedBytes: number; reason?: "budget" | "disk" } {
  const dir = opts.ticksDir ?? join(REC_DIR, "ticks");
  let bytes = opts.totalBytes ?? diskUsage().bytes;
  const free = opts.freeBytes !== undefined ? opts.freeBytes : freeSpace();
  // Two ceilings: what this directory promised to stay under, and what the volume can still spare.
  // Whichever bites, the remedy is the same and the oldest ticks go first.
  const overBudget = bytes > policy.budgetBytes;
  const lowOnDisk = free !== null && free < policy.freeFloorBytes;
  if (!overBudget && !lowOnDisk) return { removed: 0, freedBytes: 0 };
  // When the disk is the problem, free enough to clear the floor rather than the whole budget.
  const target = lowOnDisk && free !== null
    ? Math.max(0, bytes - (policy.freeFloorBytes - free))
    : policy.budgetBytes;
  if (!existsSync(dir)) return { removed: 0, freedBytes: 0 };
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".parquet"))
    .map((f) => ({ f, full: join(dir, f), when: stampTime(f) ?? statSync(join(dir, f)).mtimeMs, size: statSync(join(dir, f)).size }))
    .sort((a, b) => a.when - b.when);
  let removed = 0, freed = 0;
  // Always leave the most recent file: replay of the last few minutes is worth more than the
  // last few megabytes, and an empty ticks directory would break the replay endpoint.
  for (const file of files.slice(0, -1)) {
    if (bytes <= target) break;
    try { unlinkSync(file.full); removed++; freed += file.size; bytes -= file.size; } catch {}
  }
  return { removed, freedBytes: freed, reason: lowOnDisk ? "disk" : "budget" };
}

/**
 * Merge the many small flush files for a table into one file per day. Only files older than
 * `compactAfterHours` are touched, so nothing being written right now is disturbed.
 *
 * Crash safety is the whole difficulty here. Deleting the sources before the merged file is in
 * place opens a window where a process killed mid-compaction loses both: the sources are gone and
 * only a partial `.tmp` remains, which the startup cleanup then removes as garbage. That is not
 * hypothetical — it destroyed several hours of recordings during development. So the merged file
 * is renamed into place first (rename is atomic) and only then are the sources removed. The worst
 * a crash can now do is leave the sources behind to be merged a second time, which is why the
 * merge also de-duplicates: repeating it has to be harmless.
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
      const target = join(dir, `daily-${day}.parquet`);
      // Normally there is nothing to do until two files have accumulated. But a single leftover
      // beside an existing daily file is the signature of a crash mid-compaction: its rows are
      // already in the daily file, and skipping it would leave the duplicate there for good.
      if (files.length < 2 && !existsSync(target)) continue;
      const sources = [...files, ...(existsSync(target) ? [target] : [])];
      const list = sources.map((f) => `'${f}'`).join(", ");
      const tmp = join(dir, `daily-${day}.tmp.parquet`);
      const read = `read_parquet([${list}], union_by_name=true)`;
      await conn.run(`COPY (${dedupe(table, read)}) TO '${tmp}' (FORMAT PARQUET, COMPRESSION ZSTD)`);
      // Atomic: after this line the merged file is the file, whatever happens next.
      renameSync(tmp, target);
      for (const f of sources) if (f !== target) unlinkSync(f);
      merged[table] = (merged[table] ?? 0) + files.length;
    }
  }
  return merged;
}
