/**
 * traintime poller: fetches every MTA subway feed at its own cadence, records everything to
 * Parquet, tracks every train, and serves live state + replay over HTTP/SSE on port 7118.
 */
import { readFileSync, existsSync, watch } from "node:fs";
import { join } from "node:path";
import type { GbmModel, Network, TimingTables } from "../../src/lib/types";
import { NetworkIndex } from "../../src/lib/network";
import { Timing } from "../../src/lib/timing";
import { Tracker } from "../../src/lib/tracker";
import { FEEDS, fetchFeed, loadDecoder, makeTick } from "./feeds";
import { Recorder } from "./recorder";
import { PollerServer } from "./server";

const ROOT = join(import.meta.dirname, "..", "..");
const PORT = Number(process.env.POLLER_PORT ?? 7118);
const FLUSH_EVERY = Number(process.env.FLUSH_EVERY_SEC ?? 300);
const TIMING_PATH = join(ROOT, "data", "timing.json");
const MODEL_PATH = join(ROOT, "data", "eta-model.json");
// Committed snapshots, used until the learn/train scripts produce fresh ones.
const TIMING_SNAPSHOT = join(ROOT, "public", "data", "timing.json");
const MODEL_SNAPSHOT = join(ROOT, "public", "data", "eta-model.json");

function loadJson<T>(path: string): T | null {
  try { return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : null; } catch { return null; }
}

async function main() {
  const net = new NetworkIndex(JSON.parse(readFileSync(join(ROOT, "public", "data", "network.json"), "utf8")) as Network);
  const timing = new Timing(net, loadJson<TimingTables>(TIMING_PATH) ?? loadJson<TimingTables>(TIMING_SNAPSHOT), loadJson<GbmModel>(MODEL_PATH) ?? loadJson<GbmModel>(MODEL_SNAPSHOT));
  const tracker = new Tracker(net, timing);
  const decoder = await loadDecoder();
  const recorder = await Recorder.open();
  console.log(`[poller] network ${net.net.feedVersion}; timing ${timing.isLearned ? "learned" : "defaults"}; model ${timing.model ? "on" : "off"}`);

  // Hot-reload learned timing when the learn script rewrites it.
  const reload = () => {
    const t = loadJson<TimingTables>(TIMING_PATH);
    const m = loadJson<GbmModel>(MODEL_PATH);
    if (t) { timing.tables = t; timing.model = m; console.log(`[poller] timing reloaded (${t.generatedAt}${m ? ", model on" : ""})`); }
  };
  try { watch(join(ROOT, "data"), (_e, f) => { if (f === "timing.json" || f === "eta-model.json") setTimeout(reload, 500); }); } catch {}

  const stats = { fetches: 0, errors: 0, fresh: 0, lastEvents: 0 };
  const server = new PollerServer({
    tracker, net, timing, decoder,
    conn: () => recorder.connection,
    metrics: () => ({ ...stats, recorder: recorder.counts, trains: tracker.size, clock: tracker.clock, feeds: [...tracker.feeds.values()] }),
    flush: () => recorder.flush(),
  });
  server.listen(PORT);

  const poll = async (feed: { id: string; cadence: number }) => {
    const fetchedAt = Math.floor(Date.now() / 1000);
    const r = await fetchFeed(feed.id);
    stats.fetches++;
    if (!r.buf) {
      stats.errors++;
      tracker.feeds.set(feed.id, { id: feed.id, ok: false, error: r.error, ms: r.ms });
    } else {
      try {
        const tick = makeTick(feed.id, fetchedAt, decoder(r.buf));
        tracker.feeds.set(feed.id, { id: feed.id, ok: true, timestamp: tick.ts, ms: r.ms });
        const { events, etaObs, fresh } = tracker.ingest(tick);
        if (fresh) {
          stats.fresh++;
          stats.lastEvents = events.length;
          await recorder.record(tick, r.buf, events, etaObs);
          server.broadcast(Math.floor(Date.now() / 1000));
        }
      } catch (e) {
        stats.errors++;
        tracker.feeds.set(feed.id, { id: feed.id, ok: false, error: `decode: ${e instanceof Error ? e.message : e}`, ms: r.ms });
      }
    }
    // Aim for the feed's own cadence, slightly offset so we tend to land just after a refresh.
    setTimeout(() => poll(feed), Math.max(1000, feed.cadence * 1000 - r.ms + 500));
  };
  for (const [i, f] of FEEDS.entries()) setTimeout(() => poll(f), i * 300);

  setInterval(() => tracker.expire(Math.floor(Date.now() / 1000)), 30_000);
  setInterval(async () => {
    const w = await recorder.flush();
    console.log(`[recorder] flushed ${Object.entries(w).map(([k, v]) => `${k}=${v}`).join(" ") || "nothing"}`);
  }, FLUSH_EVERY * 1000);
  setInterval(() => {
    const feeds = [...tracker.feeds.values()];
    console.log(`[poller] trains=${tracker.size} fetches=${stats.fetches} errors=${stats.errors} feedsOk=${feeds.filter((f) => f.ok).length}/${feeds.length} ticks=${recorder.counts.ticks} events=${recorder.counts.events} etaObs=${recorder.counts.etaObs}`);
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
