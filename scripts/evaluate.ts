/**
 * Replay recorded feed ticks through the tracker + kinematics and score the result against
 * observed station events. The only truth we have is when trains actually arrived and left.
 *
 *   npx tsx scripts/evaluate.ts [--from ISO|epoch] [--to ISO|epoch] [--variant kinematic|naive]
 *                               [--timing data/timing.json | --no-timing] [--model data/eta-model.json]
 *                               [--name label] [--no-flush]
 */
import { DuckDBInstance } from "@duckdb/node-api";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import type { GbmModel, Network, TimingTables, TrainState } from "../src/lib/types";
import { NetworkIndex, parentOf } from "../src/lib/network";
import { Timing, horizonBucket } from "../src/lib/timing";
import { Tracker } from "../src/lib/tracker";
import { Kinematics } from "../src/lib/kinematics";
import { loadDecoder } from "../services/poller/feeds";
import { parquetGlob } from "../services/poller/recorder";

const ROOT = join(import.meta.dirname, "..");
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) args.set(a.slice(2), process.argv[i + 1]?.startsWith("--") || process.argv[i + 1] === undefined ? "true" : process.argv[++i]);
}
const toEpoch = (v?: string) => (v ? (Number.isFinite(Number(v)) ? Number(v) : Math.floor(new Date(v).getTime() / 1000)) : undefined);

const q = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "–");
const f0 = (x: number) => (Number.isFinite(x) ? x.toFixed(0) : "–");
const pct = (x: number) => (Number.isFinite(x) ? `${(100 * x).toFixed(0)}%` : "–");

interface Sample { key: string; s: number; L: number; next: string; reachedAt?: number }

async function main() {
  const variant = args.get("variant") ?? "kinematic";
  const timingPath = args.get("no-timing") ? null : args.get("timing") ?? (existsSync(join(ROOT, "data", "timing.json")) ? join(ROOT, "data", "timing.json") : null);
  const modelPath = args.get("model") ?? null;
  const name = args.get("name") ?? `${variant}${timingPath ? "+timing" : ""}${modelPath ? "+model" : ""}`;
  const debug = args.has("debug");
  let dbgLeft = 14;

  if (!args.get("no-flush")) {
    try { await fetch("http://localhost:7118/flush"); } catch { /* poller not running; use what is on disk */ }
  }

  const net = new NetworkIndex(JSON.parse(readFileSync(join(ROOT, "public", "data", "network.json"), "utf8")) as Network);
  const tables = timingPath ? (JSON.parse(readFileSync(timingPath, "utf8")) as TimingTables) : null;
  const model = modelPath ? (JSON.parse(readFileSync(modelPath, "utf8")) as GbmModel) : null;
  const timing = new Timing(net, tables, model);
  const tracker = new Tracker(net, timing);
  const kin = new Kinematics(net);
  const decoder = await loadDecoder();

  const db = await DuckDBInstance.create(":memory:");
  const conn = await db.connect();
  const from = toEpoch(args.get("from"));
  const to = toEpoch(args.get("to"));
  const where = [from ? `ts >= ${from - 180}` : "", to ? `ts <= ${to}` : ""].filter(Boolean).join(" AND ");
  const rows = (await conn.runAndReadAll(
    `SELECT feed, ts, fetched_at, raw FROM read_parquet('${parquetGlob("ticks")}', union_by_name=true) ${where ? `WHERE ${where}` : ""} ORDER BY fetched_at, ts, feed`,
  )).getRowObjects() as { feed: string; ts: bigint; fetched_at: bigint; raw: { bytes: Uint8Array } | Uint8Array }[];
  if (rows.length === 0) { console.error("no recorded ticks in that window"); process.exit(1); }
  const t0 = Number(rows[0].fetched_at);
  const t1 = Number(rows[rows.length - 1].fetched_at);
  const scoreFrom = from ?? t0 + 180; // give trains history before scoring
  console.log(`replaying ${rows.length} ticks, ${new Date(t0 * 1000).toISOString()} → ${new Date(t1 * 1000).toISOString()} (${((t1 - t0) / 60).toFixed(0)} min), variant=${variant}, timing=${timingPath ? "on" : "off"}, model=${model ? "on" : "off"}`);

  // --- accumulators
  const short: number[] = [];       // metres short of the platform when the train actually arrived
  const early: number[] = [];       // seconds the marker sat at the platform before the real arrival
  const behindSeg: number[] = [];   // arrivals where the marker was still on an earlier segment
  const dataLatency: number[] = [];
  const etaErr: Record<string, { raw: number[]; adj: number[]; cover: number[] }> = {};
  let reversals = 0, jumps = 0, coldPlacements = 0, steps = 0, maxSpeed = 0, maxAccel = 0, arrivals = 0;
  const pending = new Map<string, { obsTs: number; predicted: number; adjusted: number; sigma: number }[]>();
  const samples = new Map<string, Sample[]>(); // per train, ring of per-second samples (t, s)
  const prevBody = new Map<string, { key: string; s: number; v: number }>();

  let states: TrainState[] = [];
  let i = 0;
  const smooth = (p: number) => p * p * (3 - 2 * p);

  for (let t = t0; t <= t1; t++) {
    // ingest every tick fetched at or before t
    let ingested = false;
    while (i < rows.length && Number(rows[i].fetched_at) <= t) {
      const r = rows[i++];
      const bytes = r.raw instanceof Uint8Array ? r.raw : r.raw.bytes;
      let tick;
      try { const d = decoder(gunzipSync(bytes)); tick = { feed: r.feed, ts: d.ts, fetchedAt: Number(r.fetched_at), trains: d.trains }; } catch { continue; }
      const { events, etaObs, fresh } = tracker.ingest(tick);
      if (!fresh) continue;
      ingested = true;
      if (t < scoreFrom) continue;
      for (const o of etaObs) {
        const st = states.find((s) => s.id === o.tripId);
        const { hour, dow } = { hour: new Date(o.obsTs * 1000).getUTCHours(), dow: 0 };
        const adj = timing.adjustEta({ raw: o.predicted, now: o.obsTs, route: o.route, prev: o.prevStop ?? st?.prevStop, next: o.stopId, departedAt: o.departedAt, hour, dow });
        const k = `${o.tripId}|${o.stopId}`;
        (pending.get(k) ?? pending.set(k, []).get(k)!).push({ obsTs: o.obsTs, predicted: o.predicted, adjusted: adj.eta, sigma: adj.sigma });
      }
      for (const e of events) {
        dataLatency.push(tick.fetchedAt - e.ts);
        if (e.kind !== "arrive" || e.estimated) continue;
        arrivals++;
        // ETA scoring
        const k = `${e.tripId}|${e.stopId}`;
        for (const o of pending.get(k) ?? []) {
          const h = o.predicted - o.obsTs;
          if (h < -30) continue;
          const b = horizonBucket(h);
          const acc = (etaErr[b] ??= { raw: [], adj: [], cover: [] });
          acc.raw.push(e.ts - o.predicted);
          acc.adj.push(e.ts - o.adjusted);
          acc.cover.push(Math.abs(e.ts - o.adjusted) <= o.sigma ? 1 : 0);
        }
        pending.delete(k);
        // Position scoring: where was the marker at the moment of arrival?
        const ring = samples.get(e.tripId);
        const at = ring?.find((s0) => Math.abs((s0 as Sample & { t: number }).t - e.ts) < 0.5) as (Sample & { t: number }) | undefined;
        if (!at) { if (debug && dbgLeft-- > 0) console.log(`[dbg no-sample] ${e.tripId} arrive ${e.stopId} ts=${e.ts} fetched=${tick.fetchedAt} t=${t} ring=${ring?.length ?? 0} first=${(ring?.[0] as { t?: number } | undefined)?.t}`); continue; }
        if (debug && parentOf(at.next) !== parentOf(e.stopId) && dbgLeft-- > 0) {
          const st = states.find((x) => x.id === e.tripId);
          console.log(`[dbg earlier-seg] ${e.tripId} ${e.route}${e.direction} arrive ${e.stopId} ts=${e.ts} fetched=${tick.fetchedAt} | sample@${at.t}: key=${at.key} next=${at.next} s=${at.s.toFixed(0)}/${at.L.toFixed(0)} | state now: phase=${st?.phase} prev=${st?.prevStop} next=${st?.nextStop} | tick events: ${events.filter((x) => x.tripId === e.tripId).map((x) => `${x.kind}:${x.stopId}@${x.ts}`).join(",")}`);
        }
        if (parentOf(at.next) === parentOf(e.stopId)) {
          const gap = at.L - at.s;
          if (gap < 1 && at.reachedAt !== undefined) early.push(e.ts - at.reachedAt);
          else short.push(gap);
        } else {
          behindSeg.push(1);
          short.push(at.L - at.s + net.hop(at.next, e.stopId));
        }
      }
    }
    if (ingested) { tracker.expire(t); states = tracker.states(t); }

    // one second of motion
    let positions;
    if (variant === "naive") {
      positions = states.map((st) => {
        if (st.phase !== "moving" || !st.prevStop) {
          const s = net.station(st.nextStop)!;
          return { id: st.id, s: 0, length: 0, key: `at:${parentOf(st.nextStop)}`, speed: 0, next: st.nextStop, lon: s.lon, lat: s.lat };
        }
        const path = net.pathBetween(st.route, st.prevStop, st.nextStop);
        const dep = st.departedAt ?? st.etaRaw - (st.runTime ?? 90);
        const p = Math.max(0, Math.min(1, (t - dep) / Math.max(1, st.etaRaw - dep)));
        return { id: st.id, s: smooth(p) * path.length, length: path.length, key: `${st.prevStop}>${st.nextStop}`, speed: 0, next: st.nextStop };
      });
    } else {
      positions = kin.step(states, t, 1).map((p) => ({ id: p.id, s: p.s, length: p.length, key: `${p.state.prevStop}>${p.state.nextStop}`, speed: p.speed, next: p.state.nextStop, phase: p.phase }));
    }
    const seen = new Set<string>();
    for (const p of positions) {
      seen.add(p.id);
      const prev = prevBody.get(p.id);
      if (t >= scoreFrom) {
        steps++;
        if (prev && prev.key === p.key) {
          const ds = p.s - prev.s;
          if (ds < -0.5) reversals++;
          if (Math.abs(ds) > 40) jumps++;
          maxSpeed = Math.max(maxSpeed, Math.abs(ds));
          maxAccel = Math.max(maxAccel, Math.abs(p.speed - prev.v));
        } else if (prev && prev.key !== p.key && !p.key.startsWith("at:") && !prev.key.startsWith("at:") && parentOf(prev.key.split(">")[1] ?? "") !== parentOf(p.key.split(">")[0] ?? "")) {
          coldPlacements++;
        }
      }
      prevBody.set(p.id, { key: p.key, s: p.s, v: p.speed });
      const ring = samples.get(p.id) ?? samples.set(p.id, []).get(p.id)!;
      const last = ring[ring.length - 1] as (Sample & { t: number }) | undefined;
      const reachedAt = p.length > 0 && p.s >= p.length - 1 ? (last && last.key === p.key && last.reachedAt !== undefined ? last.reachedAt : t) : undefined;
      ring.push({ t, key: p.key, s: p.s, L: p.length, next: p.next, reachedAt } as Sample & { t: number });
      if (ring.length > 90) ring.shift();
    }
    for (const id of prevBody.keys()) if (!seen.has(id)) { prevBody.delete(id); samples.delete(id); }
  }

  // --- report
  const buckets = ["h0", "h1", "h2", "h3", "h4"];
  const labels: Record<string, string> = { h0: "<45 s", h1: "45–120 s", h2: "2–5 min", h3: "5–15 min", h4: ">15 min" };
  const report = {
    name, variant, timing: !!tables, model: !!model, window: { from: t0, to: t1 }, ticks: rows.length, arrivals,
    position: {
      n: short.length + early.length, behindSegment: behindSeg.length,
      shortMedianM: q(short, 0.5), shortP90M: q(short, 0.9), shortMeanM: mean(short),
      earlyShare: early.length / Math.max(1, short.length + early.length), earlyMedianS: q(early, 0.5), earlyP90S: q(early, 0.9),
    },
    motion: { steps, reversals, jumps, coldPlacements, maxSpeedMps: maxSpeed, maxAccelMps2: maxAccel },
    dataLatencyS: { median: q(dataLatency, 0.5), p90: q(dataLatency, 0.9) },
    eta: Object.fromEntries(buckets.filter((b) => etaErr[b]).map((b) => [b, {
      n: etaErr[b].raw.length,
      rawMae: mean(etaErr[b].raw.map(Math.abs)), rawBias: q(etaErr[b].raw, 0.5),
      adjMae: mean(etaErr[b].adj.map(Math.abs)), adjBias: q(etaErr[b].adj, 0.5),
      coverage: mean(etaErr[b].cover),
    }])),
  };
  mkdirSync(join(ROOT, "data", "eval"), { recursive: true });
  const out = join(ROOT, "data", "eval", `${name}.json`);
  writeFileSync(out, JSON.stringify(report, null, 2));

  console.log(`\n## ${name}\n`);
  console.log(`arrivals scored: ${arrivals} · data latency median ${f1(report.dataLatencyS.median)} s (p90 ${f1(report.dataLatencyS.p90)} s)\n`);
  console.log(`| position at real arrival | value |\n|---|---|`);
  console.log(`| marker short of platform, median | ${f0(report.position.shortMedianM)} m |`);
  console.log(`| marker short of platform, p90 | ${f0(report.position.shortP90M)} m |`);
  console.log(`| marker already at platform (early) | ${pct(report.position.earlyShare)} · median ${f0(report.position.earlyMedianS)} s early |`);
  console.log(`| still on an earlier segment | ${report.position.behindSegment} |`);
  console.log(`\n| motion | value |\n|---|---|`);
  console.log(`| reversals | ${reversals} / ${steps} steps |`);
  console.log(`| jumps > 40 m/s | ${jumps} |`);
  console.log(`| cold mid-segment placements | ${coldPlacements} |`);
  console.log(`| max speed / accel | ${f1(maxSpeed)} m/s · ${f1(maxAccel)} m/s² |`);
  console.log(`\n| horizon | n | MTA MAE | MTA bias | ours MAE | ours bias | 1σ coverage |\n|---|---|---|---|---|---|---|`);
  for (const b of buckets) {
    const e = report.eta[b];
    if (!e) continue;
    console.log(`| ${labels[b]} | ${e.n} | ${f1(e.rawMae)} s | ${f1(e.rawBias)} s | ${f1(e.adjMae)} s | ${f1(e.adjBias)} s | ${pct(e.coverage)} |`);
  }
  console.log(`\nwrote ${out}`);
  conn.closeSync();
  db.closeSync();
}

main().catch((e) => { console.error(e); process.exit(1); });
