/**
 * The poller was killed for memory most nights for six weeks because nothing said how much each
 * process in its container could use. Three DuckDB instances each assumed they had 80% of the
 * machine. These tests are what would have said so.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUDGET, CONTAINER_BYTES, PEAK_BYTES, containerLimitBytes, learnerNodeOptions, openDuckDB } from "../services/poller/memory";

test("everything alive at the learn pass's worst moment fits the container, with a tenth to spare", () => {
  assert.ok(PEAK_BYTES <= CONTAINER_BYTES * 0.9, `${PEAK_BYTES / 1e9} GB of limits against a ${CONTAINER_BYTES / 1e9} GB container`);
});

test("nothing in the poller's process tree opens DuckDB without a limit", () => {
  // The recorder, learnOnce, and the learner it spawns. A new DuckDBInstance.create anywhere in
  // these is a fourth instance assuming it owns the machine.
  const files = [
    ...readdirSync("services/poller").filter((f) => f.endsWith(".ts") && f !== "memory.ts").map((f) => join("services/poller", f)),
    "scripts/learn-timing.ts",
  ];
  for (const f of files) assert.doesNotMatch(readFileSync(f, "utf8"), /DuckDBInstance\.create\(/, `${f} opens DuckDB directly; use openDuckDB`);
});

test("openDuckDB applies the limit and the thread count", async () => {
  const db = await openDuckDB(BUDGET.learnDuckdb);
  const conn = await db.connect();
  const [row] = (await conn.runAndReadAll(
    "SELECT current_setting('memory_limit') AS mem, current_setting('threads')::INT AS threads",
  )).getRowObjectsJS() as { mem: string; threads: number }[];
  conn.closeSync();
  db.closeSync();
  assert.equal(row.threads, 4);
  // DuckDB reports its limit back in binary units: 2000 MB is 1.8 GiB.
  assert.equal(row.mem, "1.8 GiB");
});

test("the learner's heap flag is in the MiB V8 expects", () => {
  assert.equal(learnerNodeOptions, `--max-old-space-size=${Math.floor(BUDGET.learnerHeap / 1048576)}`);
});

test("the container limit reads a cgroup, an unlimited one, and none at all", () => {
  const dir = mkdtempSync(join(tmpdir(), "cgroup-"));
  writeFileSync(join(dir, "limited"), "24000000000\n");
  writeFileSync(join(dir, "unlimited"), "max\n");
  assert.equal(containerLimitBytes(join(dir, "limited")), 24_000_000_000);
  assert.equal(containerLimitBytes(join(dir, "unlimited")), null);
  assert.equal(containerLimitBytes(join(dir, "missing")), null);
  // A directory is not a missing file: that is a real error and has to surface.
  assert.throws(() => containerLimitBytes(dir));
});
