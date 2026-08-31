import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { gzipSync } from "node:zlib";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { FeedTick } from "../../src/lib/types";
import type { EtaObservation, StationEvent } from "../../src/lib/tracker";

/**
 * Where recordings are written. On a platform with a mounted volume (Railway, Fly), point
 * TRAINTIME_DATA_DIR at the mount — the container filesystem is otherwise ephemeral.
 */
export const DATA_DIR = process.env.TRAINTIME_DATA_DIR ?? join(import.meta.dirname, "..", "..", "data");
export const REC_DIR = join(DATA_DIR, "rec");
export const TABLES = ["ticks", "events", "eta_obs", "trips", "weather", "calendar"] as const;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ticks   (feed VARCHAR, ts BIGINT, fetched_at BIGINT, n_trains INTEGER, raw BLOB);
CREATE TABLE IF NOT EXISTS events  (ts BIGINT, feed_ts BIGINT, trip_id VARCHAR, route VARCHAR, direction VARCHAR,
                                    stop_id VARCHAR, kind VARCHAR, track VARCHAR, estimated BOOLEAN);
CREATE TABLE IF NOT EXISTS eta_obs (obs_ts BIGINT, trip_id VARCHAR, route VARCHAR, direction VARCHAR, stop_id VARCHAR,
                                    seq SMALLINT, predicted BIGINT, prev_stop VARCHAR, departed_at BIGINT);
CREATE TABLE IF NOT EXISTS trips   (trip_id VARCHAR, route VARCHAR, direction VARCHAR, train_id VARCHAR, assigned BOOLEAN,
                                    first_seen BIGINT, last_seen BIGINT);
`;

/** Which parquet files exist on disk, for read-side views. */
export function parquetGlob(table: (typeof TABLES)[number]): string {
  return join(REC_DIR, table, "*.parquet");
}

/**
 * Buffers everything in an in-memory DuckDB and writes one Parquet file per table every flush.
 * Parquet files are the durable store: any number of readers (Node or Python) can query them
 * while the poller keeps writing.
 */
export class Recorder {
  private conn!: DuckDBConnection;
  private instance!: DuckDBInstance;
  private trips = new Map<string, { route: string; direction: string; trainId?: string; assigned: boolean; firstSeen: number; lastSeen: number }>();
  counts = { ticks: 0, events: 0, etaObs: 0, flushes: 0 };

  static async open(): Promise<Recorder> {
    const r = new Recorder();
    r.instance = await DuckDBInstance.create(":memory:");
    r.conn = await r.instance.connect();
    await r.conn.run(SCHEMA);
    for (const t of TABLES) mkdirSync(join(REC_DIR, t), { recursive: true });
    return r;
  }

  get connection(): DuckDBConnection {
    return this.conn;
  }

  async record(tick: FeedTick, raw: Uint8Array, events: StationEvent[], etaObs: EtaObservation[]) {
    const ta = await this.conn.createAppender("ticks");
    ta.appendVarchar(tick.feed);
    ta.appendBigInt(BigInt(tick.ts));
    ta.appendBigInt(BigInt(tick.fetchedAt));
    ta.appendInteger(tick.trains.length);
    ta.appendBlob(gzipSync(raw));
    ta.endRow();
    ta.closeSync();
    this.counts.ticks++;

    if (events.length) {
      const ea = await this.conn.createAppender("events");
      for (const e of events) {
        ea.appendBigInt(BigInt(e.ts));
        ea.appendBigInt(BigInt(e.feedTs));
        ea.appendVarchar(e.tripId);
        ea.appendVarchar(e.route);
        ea.appendVarchar(e.direction);
        ea.appendVarchar(e.stopId);
        ea.appendVarchar(e.kind);
        if (e.track) ea.appendVarchar(e.track); else ea.appendNull();
        ea.appendBoolean(e.estimated);
        ea.endRow();
      }
      ea.closeSync();
      this.counts.events += events.length;
    }

    if (etaObs.length) {
      const oa = await this.conn.createAppender("eta_obs");
      for (const o of etaObs) {
        oa.appendBigInt(BigInt(o.obsTs));
        oa.appendVarchar(o.tripId);
        oa.appendVarchar(o.route);
        oa.appendVarchar(o.direction);
        oa.appendVarchar(o.stopId);
        oa.appendSmallInt(o.seq);
        oa.appendBigInt(BigInt(o.predicted));
        if (o.prevStop) oa.appendVarchar(o.prevStop); else oa.appendNull();
        if (o.departedAt !== undefined) oa.appendBigInt(BigInt(o.departedAt)); else oa.appendNull();
        oa.endRow();
      }
      oa.closeSync();
      this.counts.etaObs += etaObs.length;
    }

    for (const t of tick.trains) {
      const cur = this.trips.get(t.id);
      if (cur) { cur.lastSeen = tick.ts; cur.assigned = t.assigned; if (t.trainId) cur.trainId = t.trainId; }
      else this.trips.set(t.id, { route: t.route, direction: t.direction, trainId: t.trainId, assigned: t.assigned, firstSeen: tick.ts, lastSeen: tick.ts });
    }
  }

  /** Write buffered rows to Parquet and clear the buffers. */
  async flush(): Promise<Record<string, number>> {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const written: Record<string, number> = {};

    const tr = await this.conn.createAppender("trips");
    for (const [id, t] of this.trips) {
      tr.appendVarchar(id);
      tr.appendVarchar(t.route);
      tr.appendVarchar(t.direction);
      if (t.trainId) tr.appendVarchar(t.trainId); else tr.appendNull();
      tr.appendBoolean(t.assigned);
      tr.appendBigInt(BigInt(t.firstSeen));
      tr.appendBigInt(BigInt(t.lastSeen));
      tr.endRow();
    }
    tr.closeSync();

    for (const table of TABLES) {
      const n = Number((await this.conn.runAndReadAll(`SELECT count(*) AS n FROM ${table}`)).getRowObjects()[0].n);
      if (n === 0) continue;
      const order = table === "ticks" || table === "events" ? "ts"
        : table === "eta_obs" ? "obs_ts"
        : table === "weather" || table === "calendar" ? "hour"
        : "first_seen";
      const file = join(REC_DIR, table, `${stamp}.parquet`);
      await this.conn.run(`COPY (SELECT * FROM ${table} ORDER BY ${order}) TO '${file}' (FORMAT PARQUET, COMPRESSION ZSTD)`);
      await this.conn.run(`DELETE FROM ${table}`);
      written[table] = n;
    }
    // Keep trips whose last_seen is recent so their last_seen keeps advancing; drop the rest.
    const cutoff = Math.floor(Date.now() / 1000) - 600;
    for (const [id, t] of this.trips) if (t.lastSeen < cutoff) this.trips.delete(id);
    this.counts.flushes++;
    return written;
  }

  async close() {
    await this.flush();
    this.conn.closeSync();
    this.instance.closeSync();
  }
}
