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
import { PollerServer } from "./server";
import { FeedMonitor } from "./health";
import { ContextRecorder } from "./context";
import { compact, diskUsage, prune } from "./retention";
import { learnOnce, msUntilNightly, type LearnOutcome } from "./learn";

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

function loadJson<T>(path: string): T | null {
  try { return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : null; } catch { return null; }
}

async function main() {
  const startedAt = Math.floor(Date.now() / 1000);
  const net = new NetworkIndex(JSON.parse(readFileSync(join(ROOT, "public", "data", "network.json"), "utf8")) as Network);
  const timing = new Timing(net, loadJson<TimingTables>(TIMING_PATH) ?? loadJson<TimingTables>(TIMING_SNAPSHOT), loadJson<GbmModel>(MODEL_PATH) ?? loadJson<GbmModel>(MODEL_SNAPSHOT));
  const tracker = new Tracker(net, timing);
  const decoder = await loadDecoder();
  const recorder = await Recorder.open();
  const monitor = new FeedMonitor(FEEDS);
  const context = new ContextRecorder(recorder.connection);
  await context.init();
  console.log(`[poller] network ${net.net.feedVersion}; timing ${timing.isLearned ? "learned" : "defaults"}; model ${timing.model ? "on" : "off"}; data ${DATA_DIR}`);

  // Hot-reload learned timing whenever the nightly job or an operator rewrites it.
  const reload = () => {
    const t = loadJson<TimingTables>(TIMING_PATH);
    const m = loadJson<GbmModel>(MODEL_PATH);
    if (t) { timing.tables = t; timing.model = m ?? timing.model; console.log(`[poller] timing reloaded (${t.generatedAt})`); }
  };
  try { watch(DATA_DIR, (_e, f) => { if (f === "timing.json" || f === "eta-model.json") setTimeout(reload, 500); }); } catch {}

  const stats = { fetches: 0, errors: 0, fresh: 0, events: 0, etaObs: 0 };
  let lastLearn: LearnOutcome | null = null;
  let lastMaintenance: { at: number; pruned: Record<string, number>; compacted: Record<string, number> } | null = null;

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
        recorder: { ...recorder.counts, disk },
        context: context.status(),
        timing: { learned: timing.isLearned, model: !!timing.model, generatedAt: timing.tables?.generatedAt ?? null, events: timing.tables?.samples.events ?? 0 },
        learn: lastLearn,
        maintenance: lastMaintenance,
      };
    },
    flush: () => recorder.flush(),
  });
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

  setInterval(async () => {
    const w = await recorder.flush();
    if (Object.keys(w).length) console.log(`[recorder] flushed ${Object.entries(w).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  }, FLUSH_EVERY * 1000);

  // Housekeeping: bound the disk and keep the file count sane. Hourly is often enough.
  setInterval(async () => {
    try {
      await recorder.flush();
      const compacted = await compact(recorder.connection);
      const pruned = prune();
      lastMaintenance = { at: Math.floor(Date.now() / 1000), pruned, compacted };
      if (Object.keys(pruned).length || Object.keys(compacted).length) {
        console.log(`[maintenance] pruned ${JSON.stringify(pruned)} compacted ${JSON.stringify(compacted)} disk ${(diskUsage().bytes / 1e6).toFixed(0)} MB`);
      }
    } catch (e) {
      console.error("[maintenance] failed:", e instanceof Error ? e.message : e);
    }
  }, 3_600_000);

  // Nightly learning, at the quietest hour, with a held-out test before anything is adopted.
  const scheduleLearn = () => {
    const wait = msUntilNightly();
    setTimeout(async () => {
      if (LEARN_ENABLED) {
        console.log("[learn] starting nightly rebuild");
        await recorder.flush();
        lastLearn = await learnOnce(net);
        console.log(`[learn] ${lastLearn.adopted ? "ADOPTED" : "kept incumbent"}: ${lastLearn.reason}`);
        if (lastLearn.adopted) reload();
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
