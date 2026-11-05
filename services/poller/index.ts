/**
 * traintime poller: fetches every MTA subway feed at its own cadence, records what it sees along
 * with the weather and calendar context it will later be conditioned on, tracks every train, and
 * serves live state, replay and history over HTTP/SSE.
 *
 * It is built to run unattended for a year: feeds fail independently and recover on their own,
 * storage is bounded and compacted, and the timing tables rebuild themselves overnight — but only
 * adopt a new set if it beats the incumbent on data it has not seen.
 */
import { readFileSync, existsSync, watch } from "node:fs";
import { join } from "node:path";
import type { GbmModel, Network, TimingTables } from "../../src/lib/types";
import { NetworkIndex } from "../../src/lib/network";
import { Timing } from "../../src/lib/timing";
import { Tracker } from "../../src/lib/tracker";
import { FEEDS, fetchFeed, loadDecoder, makeTick } from "./feeds";
import { Recorder, DATA_DIR } from "./recorder";
import { PollerServer, emptyClientReport } from "./server";
import { FeedMonitor } from "./health";
import { ContextRecorder } from "./context";
import { cleanTemp, compact, diskUsage, enforceBudget, prune } from "./retention";
import { rollup, rollupStatus } from "./rollup";
import { learnOnce, modelTrainingReady, msUntilNightly, type LearnOutcome } from "./learn";
import { containerLimitBytes, PEAK_BYTES } from "./memory";
import { checkInvariants, isFailure } from "../../src/lib/invariants";

const ROOT = join(import.meta.dirname, "..", "..");
// Railway and friends inject PORT; POLLER_PORT wins locally.
const PORT = Number(process.env.POLLER_PORT ?? process.env.PORT ?? 7118);
const FLUSH_EVERY = Number(process.env.FLUSH_EVERY_SEC ?? 300);
const TIMING_PATH = join(DATA_DIR, "timing.json");
const MODEL_PATH = join(DATA_DIR, "eta-model.json");
// Committed snapshots, used until the learn/train scripts produce fresh ones.
const TIMING_SNAPSHOT = join(ROOT, "public", "data", "timing.json");
const MODEL_SNAPSHOT = join(ROOT, "public", "data", "eta-model.json");
const LEARN_ENABLED = process.env.NIGHTLY_LEARN !== "0";
/** DuckDB reports a full volume through its own IO error, so this is matched on text, not errno. */
const OUT_OF_SPACE = /No space left on device|ENOSPC/i;

function loadJson<T>(path: string): T | null {
  try { return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : null; } catch { return null; }
}

/**
 * Choose between what the volume has learned and what this image shipped, by which was built
 * later. Seeding the volume once and always preferring it would mean a poller keeps stale
 * tables forever, however much better the ones in a new deploy are; always preferring the image
 * would throw away everything learned overnight. The timestamp settles it.
 */
function newestOf<T extends { generatedAt?: string }>(learned: T | null, shipped: T | null): { tables: T | null; from: string } {
  if (!learned) return { tables: shipped, from: shipped ? "image" : "none" };
  if (!shipped) return { tables: learned, from: "volume" };
  const a = Date.parse(learned.generatedAt ?? "") || 0;
  const b = Date.parse(shipped.generatedAt ?? "") || 0;
  return b > a ? { tables: shipped, from: "image" } : { tables: learned, from: "volume" };
}

async function main() {
  const startedAt = Math.floor(Date.now() / 1000);
  const net = new NetworkIndex(JSON.parse(readFileSync(join(ROOT, "public", "data", "network.json"), "utf8")) as Network);
  const tablesPick = newestOf(loadJson<TimingTables>(TIMING_PATH), loadJson<TimingTables>(TIMING_SNAPSHOT));
  const modelPick = newestOf(loadJson<GbmModel>(MODEL_PATH), loadJson<GbmModel>(MODEL_SNAPSHOT));
  const timing = new Timing(net, tablesPick.tables, modelPick.tables);
  const tracker = new Tracker(net, timing);
  const decoder = await loadDecoder();
  const stale = cleanTemp();
  if (stale) console.log(`[recorder] cleared ${stale} partial file(s) from an interrupted write`);
  const recorder = await Recorder.open();
  const monitor = new FeedMonitor(FEEDS);
  const context = new ContextRecorder(recorder.connection);
  await context.init();
  console.log(`[poller] network ${net.net.feedVersion}; timing ${timing.isLearned ? `learned (${tablesPick.from}, ${timing.tables?.generatedAt})` : "defaults"}; model ${timing.model ? `on (${modelPick.from})` : "off"}; data ${DATA_DIR}`);

  // Hot-reload learned timing whenever the nightly job or an operator rewrites it.
  const reload = () => {
    const t = loadJson<TimingTables>(TIMING_PATH);
    const m = loadJson<GbmModel>(MODEL_PATH);
    if (t) { timing.tables = t; timing.model = m ?? timing.model; console.log(`[poller] timing reloaded (${t.generatedAt})`); }
    else console.log("[poller] timing file changed but could not be read; keeping the current tables");
  };
  try { watch(DATA_DIR, (_e, f) => { if (f === "timing.json" || f === "eta-model.json") setTimeout(reload, 500); }); } catch {}

  const stats = { fetches: 0, errors: 0, fresh: 0, events: 0, etaObs: 0 };
  let lastLearn: LearnOutcome | null = null;
  let lastMaintenance: { at: number; pruned: Record<string, number>; compacted: Record<string, number>; budget: { removed: number; freedBytes: number }; rolled?: { days: string[]; cells: number } } | null = null;

  // The health closure is built before the server exists, so it reaches it through a holder.
  let modelReady: { ready: boolean; detail: string } = { ready: false, detail: "not probed yet" };
  void modelTrainingReady().then((r) => {
    modelReady = r;
    console.log(`[learn] model retraining ${r.ready ? "available" : "unavailable"}: ${r.detail}`);
  });

  // Said at start-up rather than discovered at 03:20: the per-process limits were sized for one
  // plan's container, and the last time the container and the assumption disagreed it cost a
  // crash a night for six weeks.
  const containerBytes = containerLimitBytes();
  if (containerBytes !== null && PEAK_BYTES > containerBytes) {
    console.warn(`[memory] the learn pass may use ${(PEAK_BYTES / 1e9).toFixed(1)} GB and this container allows ` +
      `${(containerBytes / 1e9).toFixed(1)} GB — lower BUDGET in services/poller/memory.ts`);
  }

  const live: { server?: PollerServer } = {};
  const server = new PollerServer({
    tracker, net, timing, decoder,
    conn: () => recorder.connection,
    metrics: () => ({ ...stats, recorder: recorder.counts, trains: tracker.size, clock: tracker.clock, feeds: monitor.snapshot(Math.floor(Date.now() / 1000)) }),
    health: () => {
      const now = Math.floor(Date.now() / 1000);
      const feeds = monitor.summary(now);
      const disk = diskUsage();
      return {
        ok: feeds.healthy >= feeds.total - 1 && tracker.size > 0,
        uptimeS: now - startedAt,
        now, clock: tracker.clock, trains: tracker.size,
        feeds: { ...feeds, detail: monitor.snapshot(now) },
        // `retention` carries the last maintenance pass, so a budget that cannot be met is visible
        // to whatever is watching /health rather than only to whoever is reading the logs.
        recorder: { ...recorder.counts, disk, summarised: rollupStatus(), retention: lastMaintenance?.budget ?? null },
        context: context.status(),
        timing: {
          learned: timing.isLearned, model: !!timing.model,
          generatedAt: timing.tables?.generatedAt ?? null, events: timing.tables?.samples.events ?? 0,
          // Whether tonight's retrain can actually happen, known now rather than at 03:20.
          canRetrain: modelReady,
        },
        // What browsers say went wrong, and how long the page took them. Without this the only
        // half of the system we could see was the half running on our own machine — and the only
        // performance number we had came from one scripted browser on one developer's machine.
        clients: live.server?.clientErrorReport() ?? emptyClientReport(),
        // Correctness the deployed system reports about itself, rather than waiting to be asked.
        invariants: (() => {
          const states = tracker.states(now);
          const violations = checkInvariants(net, states, now);
          return {
            trains: states.length,
            failures: violations.filter(isFailure).map((v) => ({ severity: v.severity, rule: v.rule, count: v.count, detail: v.detail })),
            informational: violations.filter((v) => !isFailure(v)).map((v) => ({ rule: v.rule, count: v.count })),
            unknownStops: [...tracker.unknownStops].sort(),
          };
        })(),
        learn: lastLearn,
        maintenance: lastMaintenance,
      };
    },
    flush: () => recorder.flush(),
  });
  live.server = server;
  server.listen(PORT);

  const poll = async (feed: { id: string; cadence: number }) => {
    const fetchedAt = Math.floor(Date.now() / 1000);
    const r = await fetchFeed(feed.id);
    stats.fetches++;
    if (!r.buf) {
      stats.errors++;
      monitor.failed(feed.id, r.error ?? "unknown", r.ms, fetchedAt);
    } else {
      try {
        const tick = makeTick(feed.id, fetchedAt, decoder(r.buf));
        monitor.succeeded(feed.id, tick.ts, r.ms, fetchedAt);
        const { events, etaObs, fresh } = tracker.ingest(tick);
        if (fresh) {
          stats.fresh++;
          stats.events += events.length;
          stats.etaObs += etaObs.length;
          await recorder.record(tick, r.buf, events, etaObs);
          server.broadcast(Math.floor(Date.now() / 1000));
        }
      } catch (e) {
        stats.errors++;
        monitor.failed(feed.id, `decode: ${e instanceof Error ? e.message : e}`, r.ms, fetchedAt);
      }
    }
    tracker.feeds.set(feed.id, {
      id: feed.id, ok: monitor.get(feed.id).ok && !monitor.get(feed.id).stalled,
      timestamp: monitor.get(feed.id).lastHeaderTs, error: monitor.get(feed.id).lastError, ms: r.ms,
    });
    setTimeout(() => poll(feed), monitor.nextDelayMs(feed.id, r.ms));
  };
  for (const [i, f] of FEEDS.entries()) setTimeout(() => poll(f), i * 300);

  setInterval(() => tracker.expire(Math.floor(Date.now() / 1000)), 30_000);

  // Context: one weather and calendar row per hour. Checked often so a restart cannot skip an hour.
  const contextTick = () => context.tick().then((wrote) => { if (wrote) console.log(`[context] ${JSON.stringify(context.status())}`); }).catch(() => {});
  contextTick();
  setInterval(contextTick, 5 * 60_000);

  /**
   * Free space. Nothing here writes, so this is the only housekeeping that still works on a volume
   * with nothing left — which is exactly when housekeeping matters.
   *
   * It used to run last. Compaction and summarising both write a merged file before removing what
   * they merged, and the flush at the top of the pass writes too, so on a full disk the pass threw
   * on its first line and took pruning and the budget down with it. The only code that could free
   * the volume was sequenced behind three operations that needed the volume freed. Deleting needs
   * no room, so it goes first, and it is callable from anywhere that has just been told there is
   * none.
   */
  const reclaim = (why: string) => {
    const cleaned = cleanTemp();
    const pruned = prune();
    const budget = enforceBudget();
    // Record it. The two moments this runs outside the scheduled pass — a boot onto a full volume
    // and a flush that found no space — are the two most worth seeing, and reporting them only to
    // the log meant /health answered `retention: null` about the recovery it had just performed.
    lastMaintenance = { at: Math.floor(Date.now() / 1000), pruned, compacted: {}, budget, ...(lastMaintenance?.rolled ? { rolled: lastMaintenance.rolled } : {}) };
    if (cleaned || Object.keys(pruned).length || budget.removed) {
      console.log(`[maintenance] reclaimed (${why}): cleaned=${cleaned} pruned=${JSON.stringify(pruned)} ` +
        `budget=${JSON.stringify(budget)} disk=${(diskUsage().bytes / 1e6).toFixed(0)}MB`);
    }
    // A budget that cannot be met by deleting ticks is a configuration problem, not housekeeping:
    // it will delete the whole tick archive on every pass and still be over. Say so every time.
    if (budget.unreachableBytes) {
      console.warn(`[maintenance] budget unreachable: the tables that cannot be evicted are ` +
        `${(budget.unreachableBytes / 1e6).toFixed(0)} MB past it — raise DISK_BUDGET_BYTES or shorten a retention window`);
    }
    return { pruned, budget };
  };

  /**
   * One housekeeping step, which may fail without ending the pass.
   *
   * The pass was a single try/catch, so whichever step failed first cancelled every step after it.
   * They are independent pieces of work and a bad day for one is not a reason to skip the rest.
   */
  const step = async <T>(name: string, fn: () => Promise<T>): Promise<T | null> => {
    try { return await fn(); } catch (e) {
      console.error(`[maintenance] ${name} failed: ${e instanceof Error ? e.message : e}`);
      return null;
    }
  };

  /**
   * A flush that fails must not end the process.
   *
   * It did. The interval callback was `async` and nothing awaited it, so a rejected flush became an
   * unhandled rejection, and Node's default for those is to throw — a full volume killed the poller
   * five minutes after every boot, before the hourly pass that would have freed it could run once.
   * The recording a caught flush loses is one flush; the recording the crash loop lost was all of
   * them, indefinitely.
   */
  const flushOnce = async () => {
    try {
      const w = await recorder.flush();
      if (Object.keys(w).length) console.log(`[recorder] flushed ${Object.entries(w).map(([k, v]) => `${k}=${v}`).join(" ")}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[recorder] flush failed: ${msg}`);
      // No space is the one failure with an obvious remedy, and waiting up to an hour for the
      // scheduled pass to apply it is an hour of flushes failing the same way.
      if (OUT_OF_SPACE.test(msg)) reclaim("flush: no space");
    }
  };
  setInterval(() => void flushOnce(), FLUSH_EVERY * 1000);

  // Housekeeping: bound the disk and keep the file count sane. Hourly is often enough.
  const maintain = async (why: string) => {
    const { pruned, budget } = reclaim(why);
    await step("flush", () => recorder.flush());
    const compacted = await step("compact", () => compact(recorder.connection)) ?? {};
    // Summarise days old enough that the model no longer trains on them, before pruning can
    // reach them. The statistics outlive the rows, so a year of history stays learnable on a
    // volume that could never hold a year of observations.
    const rolled = await step("rollup", () => rollup(recorder.connection));
    // Flushing, compacting and summarising all just wrote. Hold the ceiling at the end of the pass
    // as well as the start, so the next hour begins inside the budget rather than over it.
    const after = enforceBudget();
    // Both ends of the pass enforce the same ceiling. Report them added together, rather than
    // leaving whoever reads /health to guess which half did the work.
    const total = { ...after, removed: budget.removed + after.removed, freedBytes: budget.freedBytes + after.freedBytes };
    lastMaintenance = { at: Math.floor(Date.now() / 1000), pruned, compacted, budget: total, rolled: rolled ?? undefined };
    if (rolled?.days.length) console.log(`[maintenance] summarised ${rolled.days.join(", ")} into ${rolled.cells} cells`);
    if (Object.keys(compacted).length || after.removed) {
      console.log(`[maintenance] compacted ${JSON.stringify(compacted)} budget ${JSON.stringify(total)} disk ${(diskUsage().bytes / 1e6).toFixed(0)} MB`);
    }
  };

  /*
   * Reclaim before the first feed is ever polled.
   *
   * The hourly timer is unreachable to a process that does not survive the hour, which is the state
   * a full volume put this one in: crash at minute five, restart, crash at minute five. Recovery
   * has to be something a boot does, not something a boot schedules — and since deleting is the
   * half that needs no room, a boot can always do it. The feeds start on timers below, so this
   * synchronous pass is complete before the first tick is recorded.
   */
  reclaim("startup");
  setInterval(() => void maintain("hourly"), 3_600_000);

  // Nightly learning, at the quietest hour, with a held-out test before anything is adopted.
  const scheduleLearn = () => {
    const wait = msUntilNightly();
    setTimeout(async () => {
      // A rebuild that throws must cost one night, not every night after it. Unguarded, the
      // rejection ended the process and — because the next timer is armed at the end of this
      // callback and never reached — the rebuild would not have come back even if it had not.
      try {
        if (LEARN_ENABLED) {
          console.log("[learn] starting nightly rebuild");
          // The rebuild reads what the flush is about to write, so a full volume fails it here
          // rather than halfway through. Reclaim first: this is the one hour it is worth waiting.
          reclaim("nightly");
          await recorder.flush();
          lastLearn = await learnOnce(net);
          console.log(`[learn] ${lastLearn.adopted ? "ADOPTED" : "kept incumbent"}: ${lastLearn.reason}`);
          if (lastLearn.adopted) reload();
        }
      } catch (e) {
        console.error(`[learn] nightly rebuild failed: ${e instanceof Error ? e.message : e}`);
      }
      scheduleLearn();
    }, wait);
    console.log(`[learn] next rebuild in ${(wait / 3_600_000).toFixed(1)} h`);
  };
  scheduleLearn();

  setInterval(() => {
    const now = Math.floor(Date.now() / 1000);
    const f = monitor.summary(now);
    console.log(`[poller] trains=${tracker.size} feeds=${f.healthy}/${f.total} fetches=${stats.fetches} errors=${stats.errors} events=${stats.events} disk=${(diskUsage().bytes / 1e6).toFixed(0)}MB${f.degraded.length ? ` degraded=${JSON.stringify(f.degraded)}` : ""}`);
  }, 60_000);

  const shutdown = async () => {
    console.log("[poller] shutting down, flushing…");
    await recorder.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => { console.error(e); process.exit(1); });
