/**
 * Compaction has to survive being killed at any moment. The property that makes that true is
 * that merging is idempotent: if a crash leaves the sources behind after the merged file has
 * landed, the next pass must produce the same data rather than double-counting it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, utimesSync } from "node:fs";
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
