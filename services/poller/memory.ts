/**
 * What each process in the poller's container may use, and the one way to open DuckDB.
 *
 * An unconfigured DuckDB assumes it may take 80% of the machine and one thread per core it can see.
 * During the nightly learn pass three of them were open at once — the recorder's, `learnOnce`'s
 * and the learner child's — each assuming it had that 80% to itself, beside a learner holding the
 * whole history as JS objects. On Hobby's 8 GB the kernel killed the container, recorder included,
 * at 03:20 most nights from 2026-09-15 until the restarts ran out. Measured on Pro's 24 GB, one
 * learner run took the container from 338 MB to 16.8 GB and then died of its own 4.3 GB heap.
 *
 * The learner now peaks at 4.0 GB over the same 80 days. These limits are what keeps a future
 * regression of that kind a failed learn pass rather than a dead recorder.
 */
import { readFileSync } from "node:fs";
import { DuckDBInstance } from "@duckdb/node-api";

const MB = 1e6;

/** The Pro plan's per-replica limit, as the container reports it in /sys/fs/cgroup/memory.max. */
export const CONTAINER_BYTES = 24_000 * MB;

/**
 * Per-process limits. DuckDB spills to disk past its limit, and V8 fails its own process past its
 * heap; either is a learn pass that reports why it failed, not a recorder the kernel kills.
 */
export const BUDGET = {
  /** Five minutes of buffered ticks between flushes; it has never needed more than a few hundred MB. */
  recorderDuckdb: 1_000 * MB,
  /** `learnOnce`'s held-out join. */
  learnDuckdb: 2_000 * MB,
  /** The learner child's windowed reads over the whole event history. */
  learnerDuckdb: 2_000 * MB,
  /**
   * The learner child's heap. It holds the runs and dwells the hierarchies are fitted on as numbers:
   * 20 million of them at 80 days of history, which fails under a 2 GB heap and completes under 3.
   * Events are kept for 365 days, about 4.5 times that, so this covers a full year — just. Past it,
   * the learn pass fails and says so on /health; the recorder does not notice.
   */
  learnerHeap: 12_000 * MB,
  /** The poller's own heap: Node's default limit, which it has never come near. */
  pollerHeap: 4_300 * MB,
} as const;

/**
 * Everything that is alive at once at the worst moment: the learner child building a candidate
 * while `learnOnce` holds its join and the recorder keeps recording. The model trainer runs after
 * the child has exited, and its 512 MB DuckDB plus a pandas frame is far below this.
 */
export const PEAK_BYTES =
  BUDGET.recorderDuckdb + BUDGET.learnDuckdb + BUDGET.learnerDuckdb + BUDGET.learnerHeap + BUDGET.pollerHeap;

/** DuckDB counts in powers of ten too, so "2000MB" is exactly `BUDGET.learnDuckdb`. */
export function openDuckDB(limitBytes: number): Promise<DuckDBInstance> {
  return DuckDBInstance.create(":memory:", {
    memory_limit: `${Math.floor(limitBytes / MB)}MB`,
    // Pro reports 48 cores to `nproc`, and DuckDB's working memory grows with its thread count.
    // Measured in production over 80 days of history, the whole learner took 60 s with four threads
    // and 67 s with eight: the JS fit, not DuckDB, is what the extra threads would wait on.
    threads: "4",
  });
}

/** The container's real limit, or null where nothing imposes one (a laptop, an unlimited cgroup). */
export function containerLimitBytes(path = "/sys/fs/cgroup/memory.max"): number | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8").trim();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  return raw === "max" ? null : Number(raw);
}

/** V8 counts --max-old-space-size in MiB. */
export const learnerNodeOptions = `--max-old-space-size=${Math.floor(BUDGET.learnerHeap / 2 ** 20)}`;
