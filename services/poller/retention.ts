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

/*
 * What the windows cost, measured rather than guessed: ticks 820 MB/day, observations 33, events
 * 6.5, trips 0.3. The defaults have to add up to something the volume can hold, because a policy
 * that asks for more than exists does not degrade gracefully — it deletes the one table it is
 * allowed to delete, for ever, without meeting the number it is deleting for.
 *
 *   events   365 days   2.37 GB   what every model learns from, and the cheapest table there is
 *   obs       14 days   0.46 GB   the residual tables are the least starved of the three
 *   trips    365 days   0.11 GB
 *   ticks    the rest   ~1.5 GB   about two days, and only ever needed to re-derive the above
 *                       -------
 *                        4.5 GB   against a 5 GB volume
 *
 * Events went from 400 days to 365 for the arithmetic rather than the calendar, and observations
 * from 30 days to 14 to buy that room back for ticks. The trade is deliberate: a year of events
 * takes the per-hour run-time cells from a median of sixteen samples to about four hundred and
 * fifty, and ticks buy no prediction accuracy at all — they exist so events can be re-derived when
 * the tracker changes.
 */
export const DEFAULT_POLICY: RetentionPolicy = {
  ticksDays: Number(process.env.TICKS_RETENTION_DAYS ?? 3),
  eventsDays: Number(process.env.EVENTS_RETENTION_DAYS ?? 365),
  obsDays: Number(process.env.OBS_RETENTION_DAYS ?? 14),
  compactAfterHours: 2,
  budgetBytes: Number(process.env.DISK_BUDGET_BYTES ?? 4_500_000_000),
  /*
   * Small, because this volume has one job.
   *
   * Two gigabytes was a laptop's floor — the machine has other things to do and recording trains is
   * not worth filling its disk. On a five-gigabyte volume mounted for exactly this, it meant three
   * fifths of the volume was reserved against a use that does not exist.
   */
  freeFloorBytes: Number(process.env.DISK_FREE_FLOOR_BYTES ?? 400_000_000),
};

const DAY_MS = 86_400_000;
/**
 * Slack on top of a merge's own size, so a compaction that just fits does not leave a volume with
 * nothing left for the flush that follows it.
 */
const MERGE_HEADROOM_BYTES = 128_000_000;
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
  if (!existsSync(REC_DIR)) return removed;
  // Every directory, not just the recorder's: the summariser stages `<day>.tmp.parquet` under
  // `rollups/` with the same rename-when-complete discipline, and a crash there left a partial
  // file that nothing was looking for.
  for (const entry of readdirSync(REC_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(REC_DIR, entry.name);
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

/**
 * What the recordings occupy, counted over every directory under `rec/` rather than over TABLES.
 *
 * The list was the bug. `rollups/` is written by the summariser and is not a recorder table, so a
 * budget stated over "total storage" could not see it — the summaries that exist precisely so a
 * year of history fits a 5 GB volume were the one thing the 5 GB ceiling did not count, and the
 * gap grew with every day summarised. Walking the directory means the next thing to write here is
 * accounted for on the day it appears rather than the day someone remembers the list.
 */
export function diskUsage(): { bytes: number; files: number; byTable: Record<string, number> } {
  let bytes = 0, files = 0;
  const byTable: Record<string, number> = {};
  if (!existsSync(REC_DIR)) return { bytes, files, byTable };
  for (const entry of readdirSync(REC_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(REC_DIR, entry.name);
    let t = 0;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".parquet")) continue;
      t += statSync(join(dir, f)).size;
      files++;
    }
    byTable[entry.name] = t;
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

export interface BudgetResult {
  removed: number;
  freedBytes: number;
  reason?: "budget" | "disk";
  /**
   * How far past the budget the tables this cannot evict have grown, in bytes.
   *
   * Zero in normal operation. Anything else means the budget is no longer satisfiable by deleting
   * ticks, and the caller should say so rather than let it pass as housekeeping.
   */
  unreachableBytes?: number;
}

export function enforceBudget(
  policy: RetentionPolicy = DEFAULT_POLICY,
  /** Overridable so this can be exercised against a scratch directory. */
  opts: { ticksDir?: string; totalBytes?: number; tickBytes?: number; freeBytes?: number | null } = {},
): BudgetResult {
  const dir = opts.ticksDir ?? join(REC_DIR, "ticks");
  const usage = opts.totalBytes === undefined || opts.tickBytes === undefined ? diskUsage() : null;
  let bytes = opts.totalBytes ?? usage!.bytes;
  const free = opts.freeBytes !== undefined ? opts.freeBytes : freeSpace();

  /*
   * What the budget is actually asking of the only table this can delete.
   *
   * The budget is stated over the whole directory, and everything except ticks is out of reach
   * here — events and observations age out on their own clocks and are deliberately never dropped
   * for space. So the room ticks may occupy is the budget minus whatever the untouchable tables
   * are already using, and when that goes negative the budget cannot be met at all.
   *
   * That state is reachable from the defaults rather than hypothetical: four hundred days of
   * events and thirty of observations come to 3.7 GB against a 3 GB budget. What happened then was
   * that every tick file but the newest was deleted, every cycle, the budget stayed breached, and
   * nothing anywhere said so — the archive quietly emptied itself and the number it was emptying
   * itself to satisfy was unreachable. Now the shortfall is returned and reported.
   */
  const tickBytes = opts.tickBytes ?? usage!.byTable.ticks ?? 0;
  const untouchable = Math.max(0, bytes - tickBytes);
  const unreachable = Math.max(0, untouchable - policy.budgetBytes);

  // Two ceilings: what this directory promised to stay under, and what the volume can still spare.
  // Whichever bites, the remedy is the same and the oldest ticks go first.
  const overBudget = bytes > policy.budgetBytes;
  const lowOnDisk = free !== null && free < policy.freeFloorBytes;
  if (!overBudget && !lowOnDisk) return { removed: 0, freedBytes: 0 };
  // When both bite, the tighter one wins. Taking the disk's target because the disk was low left
  // the budget still breached at the end of a pass that had just deleted for it, so it took two
  // passes — two hours — to reach a number one pass had the information to reach.
  const targets: number[] = [];
  if (overBudget) targets.push(policy.budgetBytes);
  if (lowOnDisk && free !== null) targets.push(Math.max(0, bytes - (policy.freeFloorBytes - free)));
  const target = Math.min(...targets);
  if (!existsSync(dir)) return { removed: 0, freedBytes: 0, ...(unreachable ? { unreachableBytes: unreachable } : {}) };
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
  return {
    removed, freedBytes: freed, reason: lowOnDisk ? "disk" : "budget",
    ...(unreachable ? { unreachableBytes: unreachable } : {}),
  };
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
export async function compact(
  conn: DuckDBConnection,
  policy: RetentionPolicy = DEFAULT_POLICY,
  /** Overridable so the "there is no room for this" path can be exercised on a disk that has room. */
  opts: { freeBytes?: number | null } = {},
): Promise<Record<string, number>> {
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
      /*
       * Compaction that does not fit is compaction that fills the volume and then fails.
       *
       * The merge writes the whole day again, under a temporary name, before a byte of the day can
       * be removed — so a day of ticks needs its own size free on top of itself. At the defaults a
       * day of ticks is about 820 MB and the budget leaves roughly half that, which means the merge
       * could not have succeeded: it wrote until the disk was full and left the poller a volume
       * with nothing on it to spare. Better to leave the day in small files and say why.
       */
      const need = sources.reduce((n, f) => n + statSync(f).size, 0);
      const free = opts.freeBytes !== undefined ? opts.freeBytes : freeSpace(dir);
      if (free !== null && free < need + MERGE_HEADROOM_BYTES) {
        console.warn(`[maintenance] skipped compacting ${table}/${day}: needs ${(need / 1e6).toFixed(0)} MB ` +
          `to merge and ${(free / 1e6).toFixed(0)} MB is free`);
        continue;
      }
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
