/**
 * Compaction has to survive being killed at any moment. The property that makes that true is
 * that merging is idempotent: if a crash leaves the sources behind after the merged file has
 * landed, the next pass must produce the same data rather than double-counting it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
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
  assert.ok(existsSync(join(dir, "daily-2026-08-29.parquet")), "a daily file should exist");
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
