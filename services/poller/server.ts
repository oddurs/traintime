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
import { REC_DIR, TABLES, parquetGlob } from "./recorder";
import { calendarRow } from "../../src/lib/calendar";

/** FROM-clause over a recorded table on disk plus the in-memory buffer, skipping an empty glob. */
function source(table: (typeof TABLES)[number], cols: string): string {
  const dir = join(REC_DIR, table);
  const onDisk = existsSync(dir) && readdirSync(dir).some((f) => f.endsWith(".parquet"));
  const mem = `SELECT ${cols} FROM ${table}`;
  return onDisk
    ? `(SELECT ${cols} FROM read_parquet('${parquetGlob(table)}', union_by_name=true) UNION ALL ${mem})`
    : `(${mem})`;
}

const ticksSource = () => source("ticks", "feed, ts, fetched_at, raw");

export interface ServerDeps {
  tracker: Tracker;
  net: NetworkIndex;
  timing: Timing;
  decoder: Decoder;
  conn: () => DuckDBConnection;
  metrics: () => Record<string, unknown>;
  health: () => Record<string, unknown>;
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
    server.listen(port, "0.0.0.0", () => console.log(`[server] listening on 0.0.0.0:${port}`));
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
      case "/health": {
        const h = this.deps.health();
        return json(res, h, h.ok ? 200 : 503);
      }
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
      case "/density":
        return json(res, await this.density(url));
      case "/lines":
        return json(res, await this.lines(url));
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

  /** Arrivals per time bucket, so a scrubber can show where the busy hours are. */
  private async density(url: URL) {
    const to = Number(url.searchParams.get("to") ?? Math.floor(Date.now() / 1000));
    const from = Number(url.searchParams.get("from") ?? to - 86_400);
    const buckets = Math.max(10, Math.min(600, Number(url.searchParams.get("buckets") ?? 120)));
    const step = Math.max(1, Math.round((to - from) / buckets));
    const rows = (await this.deps.conn().runAndReadAll(
      `SELECT (ts - ${from}) // ${step} AS b, count(*) AS n
       FROM ${source("events", "ts, kind, estimated")}
       WHERE kind = 'arrive' AND NOT estimated AND ts BETWEEN ${from} AND ${to}
       GROUP BY 1 ORDER BY 1`,
    )).getRowObjectsJS() as { b: number; n: number }[];
    const out = Array.from({ length: buckets }, (_, i) => ({ t: from + i * step, arrivals: 0 }));
    for (const r of rows) if (out[Number(r.b)]) out[Number(r.b)].arrivals = Number(r.n);
    return { from, to, step, buckets: out };
  }

  /**
   * Per-route service quality over a window, next to what that line normally does at this time
   * of week. "Every 9 minutes" means nothing on its own; "every 9 minutes, usually 5" is the
   * whole point of having kept the history.
   */
  private async lines(url: URL) {
    const to = Number(url.searchParams.get("to") ?? Math.floor(Date.now() / 1000));
    const from = Number(url.searchParams.get("from") ?? to - 3600);
    const ev = source("events", "ts, trip_id, route, direction, stop_id, kind, estimated");
    // The comparison is like-for-like: the same daypart, on the same kind of day, excluding the
    // window being measured so a bad hour cannot quietly become its own baseline.
    const { daypart: nowDaypart, is_weekend, is_holiday } = calendarRow(to);
    const baselineRows = (await this.deps.conn().runAndReadAll(
      `WITH cal AS (SELECT * FROM ${source("calendar", "hour, daypart, is_weekend, is_holiday")}
                    WHERE daypart = '${nowDaypart}' AND is_weekend = ${is_weekend || is_holiday}),
            a AS (
              SELECT e.route, e.stop_id, e.direction, e.ts::DOUBLE AS ts
              FROM ${ev} e JOIN cal ON cal.hour = (e.ts // 3600) * 3600
              WHERE e.kind = 'arrive' AND NOT e.estimated AND NOT (e.ts BETWEEN ${from} AND ${to})
            ), gaps AS (
              SELECT route, ts - lag(ts) OVER (PARTITION BY route, stop_id, direction ORDER BY ts) AS gap FROM a
            )
       SELECT route, quantile_cont(gap, 0.5) AS headway, count(*) AS n
       FROM gaps WHERE gap BETWEEN 30 AND 3600 GROUP BY route`,
    )).getRowObjectsJS() as { route: string; headway: number | null; n: number }[];
    const baseline = new Map(baselineRows.filter((r) => Number(r.n) >= 20).map((r) => [r.route, Math.round(Number(r.headway))]));
    const rows = (await this.deps.conn().runAndReadAll(
      `WITH a AS (
         SELECT route, stop_id, direction, ts::DOUBLE AS ts FROM ${ev}
         WHERE kind = 'arrive' AND NOT estimated AND ts BETWEEN ${from} AND ${to}
       ), gaps AS (
         SELECT route, ts - lag(ts) OVER (PARTITION BY route, stop_id, direction ORDER BY ts) AS gap FROM a
       ), d AS (
         SELECT route, ts::DOUBLE AS ts, kind, trip_id, stop_id,
                (lead(ts) OVER w)::DOUBLE AS nts, lead(kind) OVER w AS nk, lead(stop_id) OVER w AS ns
         FROM ${ev} WHERE NOT estimated AND ts BETWEEN ${from} AND ${to}
         WINDOW w AS (PARTITION BY trip_id ORDER BY ts, CASE kind WHEN 'arrive' THEN 0 ELSE 1 END)
       )
       SELECT a.route AS route,
              count(*) AS arrivals,
              (SELECT quantile_cont(gap, 0.5) FROM gaps g WHERE g.route = a.route AND gap BETWEEN 30 AND 3600) AS headway_p50,
              (SELECT quantile_cont(gap, 0.9) FROM gaps g WHERE g.route = a.route AND gap BETWEEN 30 AND 3600) AS headway_p90,
              (SELECT quantile_cont(nts - ts, 0.5) FROM d WHERE d.route = a.route AND d.kind = 'arrive' AND d.nk = 'depart' AND d.ns = d.stop_id AND nts - ts BETWEEN 5 AND 900) AS dwell_p50
       FROM a GROUP BY a.route ORDER BY arrivals DESC`,
    )).getRowObjectsJS() as { route: string; arrivals: number; headway_p50: number | null; headway_p90: number | null; dwell_p50: number | null }[];
    return {
      from, to,
      daypart: nowDaypart,
      lines: rows.map((r) => {
        const headwayP50 = r.headway_p50 === null ? null : Math.round(Number(r.headway_p50));
        const usual = baseline.get(r.route) ?? null;
        return {
          route: r.route, arrivals: Number(r.arrivals),
          headwayP50,
          headwayP90: r.headway_p90 === null ? null : Math.round(Number(r.headway_p90)),
          dwellP50: r.dwell_p50 === null ? null : Math.round(Number(r.dwell_p50)),
          headwayUsual: usual,
          // Positive means trains are coming less often than they normally do at this hour.
          headwayRatio: usual && headwayP50 ? +(headwayP50 / usual).toFixed(2) : null,
          etaBias: null,
        };
      }),
    };
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
