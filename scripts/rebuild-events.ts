/**
 * Regenerate events and ETA observations from the raw recorded ticks by replaying them through
 * the current Tracker. The raw ticks are canonical; events are a derived cache, so this is the
 * way to apply tracker fixes to history. Replaces data/rec/events and data/rec/eta_obs.
 *
 *   npx tsx scripts/rebuild-events.ts [--no-flush]
 */
import { DuckDBInstance } from "@duckdb/node-api";
import { readFileSync, readdirSync, unlinkSync, mkdirSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import type { Network } from "../src/lib/types";
import { NetworkIndex } from "../src/lib/network";
import { Timing } from "../src/lib/timing";
import { Tracker, type EtaObservation, type StationEvent } from "../src/lib/tracker";
import { loadDecoder } from "../services/poller/feeds";
import { REC_DIR, parquetGlob } from "../services/poller/recorder";

const ROOT = join(import.meta.dirname, "..");

async function main() {
  if (!process.argv.includes("--no-flush")) { try { await fetch("http://localhost:7118/flush"); } catch { /* fine */ } }
  const net = new NetworkIndex(JSON.parse(readFileSync(join(ROOT, "public", "data", "network.json"), "utf8")) as Network);
  const tracker = new Tracker(net, new Timing(net));
  const decoder = await loadDecoder();
  const db = await DuckDBInstance.create(":memory:");
  const conn = await db.connect();
  const rows = (await conn.runAndReadAll(`SELECT feed, ts, fetched_at, raw FROM read_parquet('${parquetGlob("ticks")}', union_by_name=true) ORDER BY fetched_at, ts, feed`))
    .getRowObjects() as { feed: string; ts: bigint; fetched_at: bigint; raw: { bytes: Uint8Array } | Uint8Array }[];
  console.log(`replaying ${rows.length} ticks`);
  const events: StationEvent[] = [];
  const etaObs: EtaObservation[] = [];
  let lastExpire = 0;
  for (const r of rows) {
    const bytes = r.raw instanceof Uint8Array ? r.raw : r.raw.bytes;
    let d;
    try { d = decoder(gunzipSync(bytes)); } catch { continue; }
    const res = tracker.ingest({ feed: r.feed, ts: d.ts, fetchedAt: Number(r.fetched_at), trains: d.trains });
    events.push(...res.events);
    etaObs.push(...res.etaObs);
    const t = Number(r.fetched_at);
    if (t - lastExpire > 30) { tracker.expire(t); lastExpire = t; }
  }
  await conn.run(`CREATE TABLE events (ts BIGINT, feed_ts BIGINT, trip_id VARCHAR, route VARCHAR, direction VARCHAR, stop_id VARCHAR, kind VARCHAR, track VARCHAR, estimated BOOLEAN)`);
  await conn.run(`CREATE TABLE eta_obs (obs_ts BIGINT, trip_id VARCHAR, route VARCHAR, direction VARCHAR, stop_id VARCHAR, seq SMALLINT, predicted BIGINT, prev_stop VARCHAR, departed_at BIGINT)`);
  const ea = await conn.createAppender("events");
  for (const e of events) {
    ea.appendBigInt(BigInt(e.ts)); ea.appendBigInt(BigInt(e.feedTs)); ea.appendVarchar(e.tripId); ea.appendVarchar(e.route); ea.appendVarchar(e.direction);
    ea.appendVarchar(e.stopId); ea.appendVarchar(e.kind); if (e.track) ea.appendVarchar(e.track); else ea.appendNull(); ea.appendBoolean(e.estimated); ea.endRow();
  }
  ea.closeSync();
  const oa = await conn.createAppender("eta_obs");
  for (const o of etaObs) {
    oa.appendBigInt(BigInt(o.obsTs)); oa.appendVarchar(o.tripId); oa.appendVarchar(o.route); oa.appendVarchar(o.direction); oa.appendVarchar(o.stopId);
    oa.appendSmallInt(o.seq); oa.appendBigInt(BigInt(o.predicted)); if (o.prevStop) oa.appendVarchar(o.prevStop); else oa.appendNull();
    if (o.departedAt !== undefined) oa.appendBigInt(BigInt(o.departedAt)); else oa.appendNull(); oa.endRow();
  }
  oa.closeSync();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  for (const table of ["events", "eta_obs"] as const) {
    const dir = join(REC_DIR, table);
    mkdirSync(dir, { recursive: true });
    const old = readdirSync(dir).filter((f) => f.endsWith(".parquet"));
    const file = join(dir, `rebuilt-${stamp}.parquet`);
    await conn.run(`COPY (SELECT * FROM ${table} ORDER BY ${table === "events" ? "ts" : "obs_ts"}) TO '${file}' (FORMAT PARQUET, COMPRESSION ZSTD)`);
    for (const f of old) unlinkSync(join(dir, f));
    console.log(`${table}: wrote ${table === "events" ? events.length : etaObs.length} rows, removed ${old.length} old files`);
  }
  conn.closeSync();
  db.closeSync();
}

main().catch((e) => { console.error(e); process.exit(1); });
