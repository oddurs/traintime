import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { gunzipSync } from "node:zlib";
import type { DuckDBConnection } from "@duckdb/node-api";
import type { FeedTick } from "../../src/lib/types";
import { Tracker } from "../../src/lib/tracker";
import { NetworkIndex } from "../../src/lib/network";
import { Timing } from "../../src/lib/timing";
import type { Decoder } from "./feeds";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { REC_DIR, parquetGlob } from "./recorder";

/** FROM-clause over ticks on disk plus the in-memory buffer; skips the glob when no files exist yet. */
function ticksSource(): string {
  const dir = join(REC_DIR, "ticks");
  const onDisk = existsSync(dir) && readdirSync(dir).some((f) => f.endsWith(".parquet"));
  return onDisk
    ? `(SELECT feed, ts, fetched_at, raw FROM read_parquet('${parquetGlob("ticks")}', union_by_name=true) UNION ALL SELECT feed, ts, fetched_at, raw FROM ticks)`
    : `(SELECT feed, ts, fetched_at, raw FROM ticks)`;
}

export interface ServerDeps {
  tracker: Tracker;
  net: NetworkIndex;
  timing: Timing;
  decoder: Decoder;
  conn: () => DuckDBConnection;
  metrics: () => Record<string, unknown>;
  flush: () => Promise<Record<string, number>>;
}

type SseClient = ServerResponse;

function sse(res: ServerResponse) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "access-control-allow-origin": "*",
    "x-accel-buffering": "no",
  });
  res.write(": connected\n\n");
}

function send(res: ServerResponse, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function json(res: ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/** HTTP + SSE front door for the poller: live state, live stream, replay, timing, metrics. */
export class PollerServer {
  private clients = new Set<SseClient>();
  private lastSnapshotAt = 0;

  constructor(private deps: ServerDeps) {}

  listen(port: number) {
    const server = createServer((req, res) => this.handle(req, res).catch((e) => json(res, { error: String(e) }, 500)));
    server.listen(port, () => console.log(`[server] listening on http://localhost:${port}`));
    setInterval(() => { for (const c of this.clients) c.write(": ping\n\n"); }, 20_000).unref();
    return server;
  }

  /** Push the latest state to every live client: a delta normally, a full snapshot once a minute. */
  broadcast(now: number) {
    if (this.clients.size === 0) return;
    const full = now - this.lastSnapshotAt >= 60;
    const payload = full ? this.deps.tracker.snapshot(now) : this.deps.tracker.delta(now);
    if (full) this.lastSnapshotAt = now;
    else if (payload.trains.length === 0 && (payload as { removed: string[] }).removed.length === 0) return;
    for (const c of this.clients) send(c, full ? "snapshot" : "delta", payload);
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const now = Math.floor(Date.now() / 1000);
    switch (url.pathname) {
      case "/health":
        return json(res, { ok: true, trains: this.deps.tracker.size, clock: this.deps.tracker.clock, now });
      case "/metrics":
        return json(res, this.deps.metrics());
      case "/state":
        return json(res, this.deps.tracker.snapshot(now));
      case "/timing":
        return json(res, { learned: this.deps.timing.isLearned, model: !!this.deps.timing.model, tables: this.deps.timing.tables && {
          generatedAt: this.deps.timing.tables.generatedAt, window: this.deps.timing.tables.window, samples: this.deps.timing.tables.samples,
          runTime: Object.keys(this.deps.timing.tables.runTime).length, residual: Object.keys(this.deps.timing.tables.residual).length,
        } });
      case "/flush":
        return json(res, await this.deps.flush());
      case "/stream": {
        sse(res);
        this.clients.add(res);
        send(res, "snapshot", this.deps.tracker.snapshot(now));
        req.on("close", () => this.clients.delete(res));
        return;
      }
      case "/replay":
        return this.replay(url, req, res);
      case "/recordings":
        return json(res, await this.recordings());
      default:
        return json(res, { error: "not found" }, 404);
    }
  }

  private async recordings() {
    // A flush may be writing a new Parquet file at this moment; one retry covers that window.
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await this.deps.conn().runAndReadAll(`SELECT min(ts) AS from_ts, max(ts) AS to_ts, count(*) AS ticks FROM ${ticksSource()}`);
        const row = r.getRowObjects()[0];
        return { from: Number(row.from_ts ?? 0), to: Number(row.to_ts ?? 0), ticks: Number(row.ticks ?? 0) };
      } catch (e) {
        if (attempt >= 1) throw e;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }

  /**
   * Replay recorded ticks through a fresh tracker, streaming deltas at `speed`× real time.
   * Same code path as live, so what you see is exactly what the live map would have shown.
   */
  private async replay(url: URL, req: IncomingMessage, res: ServerResponse) {
    const from = Number(url.searchParams.get("from"));
    const to = Number(url.searchParams.get("to") ?? from + 3600);
    const speed = Math.max(0.1, Math.min(120, Number(url.searchParams.get("speed") ?? 10)));
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return json(res, { error: "from/to (epoch seconds) required" }, 400);

    // Warm up from 3 minutes earlier so trains have history when the window opens.
    const warm = from - 180;
    const rows = await this.deps.conn().runAndReadAll(
      `SELECT feed, ts, fetched_at, raw FROM ${ticksSource()} WHERE ts BETWEEN ${warm} AND ${to} ORDER BY ts, feed`,
    );
    const ticks = rows.getRowObjects() as { feed: string; ts: bigint; fetched_at: bigint; raw: { bytes: Uint8Array } | Uint8Array }[];
    if (ticks.length === 0) return json(res, { error: "no recordings in that window" }, 404);

    sse(res);
    const tracker = new Tracker(this.deps.net, this.deps.timing);
    let closed = false;
    req.on("close", () => (closed = true));
    let i = 0;
    let lastTs = 0;
    const decode = (raw: { bytes: Uint8Array } | Uint8Array): FeedTick | null => {
      const bytes = raw instanceof Uint8Array ? raw : raw.bytes;
      try {
        const d = this.deps.decoder(gunzipSync(bytes));
        return { feed: ticks[i].feed, ts: d.ts, fetchedAt: Number(ticks[i].fetched_at), trains: d.trains };
      } catch { return null; }
    };
    const pump = () => {
      if (closed) return;
      if (i >= ticks.length) { send(res, "end", { ts: lastTs }); res.end(); return; }
      const ts = Number(ticks[i].ts);
      const tick = decode(ticks[i].raw);
      if (tick) {
        tracker.ingest(tick);
        tracker.expire(ts);
        if (ts >= from) {
          if (lastTs === 0 || ts - lastTs >= 60) send(res, "snapshot", tracker.snapshot(ts, false));
          else send(res, "delta", tracker.delta(ts, false));
          if (lastTs === 0 || ts - lastTs >= 60) lastTs = ts;
        }
      }
      i++;
      const nextTs = i < ticks.length ? Number(ticks[i].ts) : ts;
      const wait = ts < from ? 0 : Math.max(0, (nextTs - ts) * 1000 / speed);
      setTimeout(pump, wait);
    };
    send(res, "replay", { from, to, speed, ticks: ticks.length });
    pump();
  }
}
