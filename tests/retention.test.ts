/**
 * Compaction has to survive being killed at any moment. The property that makes that true is
 * that merging is idempotent: if a crash leaves the sources behind after the merged file has
 * landed, the next pass must produce the same data rather than double-counting it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";

// The retention module resolves its data directory when it is first loaded, so this has to be
// set before the import below — which is why the import happens inside the test.
const root = mkdtempSync(join(tmpdir(), "tt-compact-"));
process.env.TRAINTIME_DATA_DIR = root;

async function seed(dir: string, files: { name: string; rows: [number, string][] }[]) {
  const db = await DuckDBInstance.create(":memory:");
  const c = await db.connect();
  for (const f of files) {
    const values = f.rows.map(([ts, feed]) => `(${ts}, ${ts}, '${feed}', 1, NULL::BLOB)`).join(", ");
    await c.run(`COPY (SELECT * FROM (VALUES ${values}) AS t(ts, fetched_at, feed, n_trains, raw)) TO '${join(dir, f.name)}' (FORMAT PARQUET)`);
  }
  c.closeSync(); db.closeSync();
}

async function countRows(dir: string): Promise<number> {
  const db = await DuckDBInstance.create(":memory:");
  const c = await db.connect();
  const r = await c.runAndReadAll(`SELECT count(*) n FROM read_parquet('${dir}/*.parquet', union_by_name=true)`);
  const n = Number(r.getRowObjectsJson()[0].n);
  c.closeSync(); db.closeSync();
  return n;
}

test("compaction merges without losing rows, and repeating it changes nothing", async () => {
  const { compact } = await import("../services/poller/retention");
  const dir = join(root, "rec", "ticks");
  mkdirSync(dir, { recursive: true });
  // Two old flush files that should merge, plus a recent one that must be left alone.
  const old = Date.now() / 1000 - 86_400 * 2;
  await seed(dir, [
    { name: "2026-08-29T01-00-00.parquet", rows: [[old, "gtfs"], [old + 5, "gtfs"]] },
    { name: "2026-08-29T01-05-00.parquet", rows: [[old + 10, "gtfs"], [old + 15, "gtfs-l"]] },
  ]);
  // Backdate them past the compaction threshold.
  for (const f of readdirSync(dir)) utimesSync(join(dir, f), new Date(Date.now() - 6 * 3600_000), new Date(Date.now() - 6 * 3600_000));

  const before = await countRows(dir);
  assert.equal(before, 4, "four rows to start with");

  const db = await DuckDBInstance.create(":memory:");
  const conn = await db.connect();
  await compact(conn);
  const after = await countRows(dir);
  assert.equal(after, before, "compaction must not lose a single row");
  // Ticks merge by the hour, not the day: both seeded files are in hour 01.
  assert.ok(existsSync(join(dir, "hourly-2026-08-29T01.parquet")), "an hourly file should exist");
  assert.ok(!readdirSync(dir).some((f) => f.endsWith(".tmp.parquet")), "no partial file may be left behind");

  // Simulate the crash window: the merged file is in place and a source reappears. Merging again
  // must not duplicate what is already there.
  await seed(dir, [{ name: "2026-08-29T01-05-00.parquet", rows: [[old + 10, "gtfs"], [old + 15, "gtfs-l"]] }]);
  for (const f of readdirSync(dir)) utimesSync(join(dir, f), new Date(Date.now() - 6 * 3600_000), new Date(Date.now() - 6 * 3600_000));
  await compact(conn);
  assert.equal(await countRows(dir), before, "merging a second time must be a no-op, not a doubling");

  conn.closeSync(); db.closeSync();
});

/**
 * The budget is stated over the whole directory but can only be met by deleting ticks. So the
 * question that matters is what it does when the tables it cannot touch have grown past the budget
 * on their own — which the defaults used to reach on their own within a year.
 */
test("a budget the untouchable tables have already broken is reported, not silently chased", async () => {
  const { enforceBudget } = await import("../services/poller/retention");
  const dir = mkdtempSync(join(tmpdir(), "tt-budget-"));
  const day = (n: number) => join(dir, `2026-08-${String(n).padStart(2, "0")}.parquet`);
  for (let i = 1; i <= 4; i++) writeFileSync(day(i), Buffer.alloc(100_000));

  const policy = {
    ticksDays: 3, eventsDays: 365, obsDays: 14, compactAfterHours: 2,
    budgetBytes: 1_000_000, freeFloorBytes: 0,
  };

  // Events and observations alone are over budget: ticks cannot get the total back under it.
  const stuck = enforceBudget(policy, { ticksDir: dir, totalBytes: 1_900_000, tickBytes: 400_000, freeBytes: null });
  assert.equal(stuck.unreachableBytes, 500_000, "the shortfall the caller has to hear about");
  // It still frees what it can — but it does not pretend the number was met.
  assert.ok(stuck.removed > 0);
  // And it never takes the last file: replay of the last few minutes outlives the last few bytes.
  assert.ok(existsSync(day(4)));

  // The ordinary case says nothing about a shortfall, because there is none.
  for (let i = 1; i <= 4; i++) if (!existsSync(day(i))) writeFileSync(day(i), Buffer.alloc(100_000));
  const fine = enforceBudget(policy, { ticksDir: dir, totalBytes: 1_200_000, tickBytes: 400_000, freeBytes: null });
  assert.equal(fine.unreachableBytes, undefined);
  assert.equal(fine.reason, "budget");

  // Under budget and with room on the volume, nothing is touched at all.
  const idle = enforceBudget(policy, { ticksDir: dir, totalBytes: 500_000, tickBytes: 200_000, freeBytes: null });
  assert.deepEqual(idle, { removed: 0, freedBytes: 0 });
});

/**
 * The budget is a promise about a directory, so it has to be measured over the directory. It was
 * measured over a list of table names instead, and `rollups/` is not a table — so the summaries
 * that exist precisely so a year of history fits the volume were invisible to the ceiling meant to
 * keep it fitting, and the gap grew with every day summarised.
 */
test("disk usage counts every directory under rec/, including the ones that are not tables", async () => {
  const { diskUsage } = await import("../services/poller/retention");
  const rec = join(root, "rec");
  for (const d of ["events", "rollups"]) mkdirSync(join(rec, d), { recursive: true });
  writeFileSync(join(rec, "events", "2026-08-01.parquet"), Buffer.alloc(1_000));
  writeFileSync(join(rec, "rollups", "2026-08-01.parquet"), Buffer.alloc(4_000));

  const usage = diskUsage();
  assert.equal(usage.byTable.rollups, 4_000, "the summaries occupy the volume and must be counted");
  assert.ok(usage.bytes >= 5_000, "the total includes them too");
});

/**
 * Compaction rewrites a whole day before it may delete any of it, so it needs that day's size free
 * on top of the day itself. At the defaults a day of ticks is about 820 MB against a few hundred
 * megabytes of headroom — the merge could not have succeeded, and what it did instead was write
 * until the volume was full and then fail, leaving the poller no room to flush into. A day left in
 * small files is slower to read; a full volume stops the recording altogether.
 */
test("compaction that would not fit is skipped, not attempted", async () => {
  const { compact } = await import("../services/poller/retention");
  const dir = join(root, "rec", "trips");
  mkdirSync(dir, { recursive: true });
  const names = ["2026-08-28T01-00-00.parquet", "2026-08-28T02-00-00.parquet"];
  for (const n of names) writeFileSync(join(dir, n), Buffer.alloc(2_000));
  const backdated = new Date(Date.now() - 6 * 3600_000);
  for (const f of readdirSync(dir)) utimesSync(join(dir, f), backdated, backdated);

  const db = await DuckDBInstance.create(":memory:");
  const conn = await db.connect();
  // Not a byte to spare. The files are not even valid Parquet — if the guard let the merge start,
  // DuckDB would reject them and this would throw rather than return.
  const merged = await compact(conn, undefined, { freeBytes: 1_000 });
  conn.closeSync(); db.closeSync();

  assert.deepEqual(merged, {}, "nothing was merged");
  for (const n of names) assert.ok(existsSync(join(dir, n)), `${n} is left where it was`);
  assert.ok(!existsSync(join(dir, "daily-2026-08-28.parquet")), "no half-written daily file");
  assert.ok(!existsSync(join(dir, "hourly-2026-08-28T01.parquet")), "nor an hourly one");
  assert.ok(!readdirSync(dir).some((f) => f.endsWith(".tmp.parquet")), "and nothing partial behind");

  // These are deliberately not valid Parquet, and the data directory is shared by every test in
  // this file — so they have to go, or the next test to compact with room reads them and fails.
  for (const n of names) unlinkSync(join(dir, n));
});


/**
 * The grouping is the whole reason compaction can run at all. A merge rewrites its group before it
 * may delete any of it, so a group of ticks has to be something the volume can hold twice — and a
 * day of them is not. This pins which table gets which unit, because getting it wrong is silent:
 * the merge is skipped for want of room and the files it existed to collapse simply stay.
 */
test("ticks merge by the hour and everything else by the day", async () => {
  const { compact, stampTime } = await import("../services/poller/retention");
  const backdated = new Date(Date.now() - 6 * 3600_000);
  // Two hours of one day, two flush files each.
  const files = [
    { name: "2026-07-04T05-00-00.parquet", rows: [[1, "gtfs"]] as [number, string][] },
    { name: "2026-07-04T05-30-00.parquet", rows: [[2, "gtfs"]] as [number, string][] },
    { name: "2026-07-04T06-00-00.parquet", rows: [[3, "gtfs"]] as [number, string][] },
    { name: "2026-07-04T06-30-00.parquet", rows: [[4, "gtfs"]] as [number, string][] },
  ];
  const prepare = async (table: string) => {
    const d = join(root, "rec", table);
    mkdirSync(d, { recursive: true });
    await seed(d, files);
    for (const f of readdirSync(d)) utimesSync(join(d, f), backdated, backdated);
    return d;
  };
  const ticks = await prepare("ticks");
  const events = await prepare("events");

  const db = await DuckDBInstance.create(":memory:");
  const conn = await db.connect();
  await compact(conn);
  conn.closeSync(); db.closeSync();

  // One merged file per hour for ticks, because a day of them cannot be rewritten in place.
  assert.ok(existsSync(join(ticks, "hourly-2026-07-04T05.parquet")), "hour 05 merged on its own");
  assert.ok(existsSync(join(ticks, "hourly-2026-07-04T06.parquet")), "hour 06 merged on its own");
  assert.ok(!existsSync(join(ticks, "daily-2026-07-04.parquet")), "and never as a whole day");
  // Events are small enough that a day is the right unit, and a year of days is cheap to read.
  assert.ok(existsSync(join(events, "daily-2026-07-04.parquet")), "events merged as one day");
  assert.equal(readdirSync(events).filter((f) => f.startsWith("hourly-")).length, 0);
  // Every source is gone, and no partial file anywhere.
  for (const f of files) assert.ok(!existsSync(join(ticks, f.name)), `${f.name} was consumed`);
  for (const d of [ticks, events]) assert.ok(!readdirSync(d).some((f) => f.endsWith(".tmp.parquet")));

  // An hourly stamp has to parse, or prune and the budget cannot tell how old the file is — and a
  // name that says nothing falls back to mtime, which the merge has just reset to now.
  assert.equal(stampTime("hourly-2026-07-04T05.parquet"), Date.UTC(2026, 6, 4, 5, 0, 0));
  assert.equal(stampTime("daily-2026-07-04.parquet"), Date.UTC(2026, 6, 4, 0, 0, 0));
  assert.equal(stampTime("2026-07-04T05-30-00.parquet"), Date.UTC(2026, 6, 4, 5, 30, 0));
});

/**
 * The summariser has to finish with a day before `prune` reaches it. These two windows were set by
 * two unrelated constants, one moved, and the pair became unsatisfiable — so nothing was ever
 * summarised and `/health` reported that as "nothing to summarise".
 */
test("the rollup window always falls inside the observation window", async () => {
  const { rollupAfterDays } = await import("../services/poller/rollup");
  const policy = (obsDays: number) => ({
    ticksDays: 3, eventsDays: 365, obsDays, compactAfterHours: 2,
    budgetBytes: 4_500_000_000, freeFloorBytes: 400_000_000,
  });

  delete process.env.ROLLUP_AFTER_DAYS;
  assert.equal(rollupAfterDays(policy(14)), 13, "a day of margin inside a 14-day window");
  assert.equal(rollupAfterDays(policy(30)), 29);
  assert.equal(rollupAfterDays(policy(1)), 1, "never zero or negative");

  // The value that shipped. It has to be pulled back inside the window rather than honoured.
  process.env.ROLLUP_AFTER_DAYS = "21";
  assert.equal(rollupAfterDays(policy(14)), 13, "an override past the window cannot disable the rollup");
  process.env.ROLLUP_AFTER_DAYS = "7";
  assert.equal(rollupAfterDays(policy(14)), 7, "an override inside the window is honoured");
  process.env.ROLLUP_AFTER_DAYS = "nonsense";
  assert.equal(rollupAfterDays(policy(14)), 13);
  delete process.env.ROLLUP_AFTER_DAYS;
});
