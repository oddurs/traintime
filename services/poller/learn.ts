/**
 * Nightly learning. Rebuilding the timing tables from a longer history should make the map
 * better, but "should" is not good enough to deploy unattended: tables built from a bad night
 * (a blizzard, a systemwide outage) could easily be worse than the ones already running. So a
 * candidate is built from everything except the most recent quarter of observations, scored
 * against that held-out quarter alongside the incumbent, and only adopted if it wins.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { TimingTables } from "../../src/lib/types";
import { NetworkIndex } from "../../src/lib/network";
import { Timing } from "../../src/lib/timing";
import { nyHourDow } from "../../src/lib/tracker";
import { DATA_DIR } from "./recorder";
import { parquetGlob } from "./recorder";
import type { DuckDBConnection } from "@duckdb/node-api";
import { BUDGET, learnerNodeOptions, openDuckDB } from "./memory";

const ROOT = join(import.meta.dirname, "..", "..");

/** What the nightly model retrain did, if anything. */
export interface ModelOutcome {
  ran: boolean;
  adopted?: boolean;
  tookS?: number;
  reason: string;
}

export interface LearnOutcome {
  at: number;
  ok: boolean;
  adopted: boolean;
  reason: string;
  incumbentMae?: number;
  candidateMae?: number;
  testRows?: number;
  events?: number;
  model?: ModelOutcome;
}

function run(args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    // The heap cap reaches every node in the npx → tsx → script chain, so the learner fails itself
    // with a heap error long before the container runs out.
    const env = { ...process.env, NODE_OPTIONS: [process.env.NODE_OPTIONS, learnerNodeOptions].filter(Boolean).join(" ") };
    const p = spawn("npx", ["tsx", ...args], { cwd: ROOT, env });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ code: code ?? 1, out }));
  });
}

interface TestRow { obs_ts: number; predicted: number; prev_stop: string | null; route: string; stop_id: string; departed_at: number | null; actual: number }

/**
 * Mean absolute error of each table set's corrected arrival times over the held-out observations.
 *
 * Streamed, and every table set scored in the same pass: the held-out quarter used to be read
 * whole into the poller's own heap and kept there while the learner child built the candidate,
 * which is the one moment the container had least room to spare.
 */
async function score(conn: DuckDBConnection, sql: string, net: NetworkIndex, tableSets: (TimingTables | null)[]): Promise<{ mae: number[]; rows: number }> {
  const timings = tableSets.map((t) => new Timing(net, t, null));
  const sums = timings.map(() => 0);
  // The hour and weekday are fixed for an hour; nyHourDow is an Intl call.
  const hours = new Map<number, { hour: number; dow: number }>();
  let rows = 0;
  const result = await conn.stream(sql);
  for await (const chunk of result.yieldRowObjectJs()) {
    for (const r of chunk as unknown as TestRow[]) {
      const h = Math.floor(r.obs_ts / 3600);
      const when = hours.get(h) ?? hours.set(h, nyHourDow(r.obs_ts)).get(h)!;
      const input = {
        raw: r.predicted, now: r.obs_ts, route: r.route,
        prev: r.prev_stop ?? undefined, next: r.stop_id,
        departedAt: r.departed_at ?? undefined, hour: when.hour, dow: when.dow,
      };
      for (let i = 0; i < timings.length; i++) sums[i] += Math.abs(r.actual - timings[i].adjustEta(input).eta);
      rows++;
    }
  }
  return { mae: sums.map((s) => (rows ? s / rows : Infinity)), rows };
}

export async function learnOnce(net: NetworkIndex): Promise<LearnOutcome> {
  const at = Math.floor(Date.now() / 1000);
  const live = join(DATA_DIR, "timing.json");
  const candidatePath = join(DATA_DIR, "timing.candidate.json");
  const db = await openDuckDB(BUDGET.learnDuckdb);
  const conn = await db.connect();
  try {
    const joined = `
      SELECT eo.obs_ts::DOUBLE AS obs_ts, eo.predicted::DOUBLE AS predicted, eo.prev_stop, eo.route,
             eo.stop_id, eo.departed_at::DOUBLE AS departed_at, ev.ts::DOUBLE AS actual
      FROM read_parquet('${parquetGlob("eta_obs")}', union_by_name=true) eo
      JOIN read_parquet('${parquetGlob("events")}', union_by_name=true) ev
        ON ev.trip_id = eo.trip_id AND ev.stop_id = eo.stop_id AND ev.kind = 'arrive' AND NOT ev.estimated
      WHERE ev.ts >= eo.obs_ts - 5 AND eo.predicted - eo.obs_ts >= -30 AND abs(ev.ts - eo.predicted) < 900`;

    const bounds = (await conn.runAndReadAll(
      `SELECT count(*) AS n, quantile_cont(obs_ts, 0.75) AS split FROM (${joined})`,
    )).getRowObjectsJS() as { n: number; split: number }[];
    const total = Number(bounds[0]?.n ?? 0);
    if (total < 4000) {
      return { at, ok: true, adopted: false, reason: `only ${total} scored observations; need 4000`, testRows: total };
    }
    const split = Math.floor(Number(bounds[0].split));

    // Candidate is built only from what precedes the held-out window.
    const build = await run(["scripts/learn-timing.ts", "--no-flush", "--to", String(split), "--out", candidatePath]);
    if (build.code !== 0 || !existsSync(candidatePath)) {
      return { at, ok: false, adopted: false, reason: `candidate build failed: ${build.out.trim().slice(-200)}` };
    }
    const candidate = JSON.parse(readFileSync(candidatePath, "utf8")) as TimingTables;
    const incumbent = existsSync(live) ? (JSON.parse(readFileSync(live, "utf8")) as TimingTables) : null;

    const scored = await score(conn, `SELECT * FROM (${joined}) WHERE obs_ts > ${split}`, net, [candidate, incumbent]);
    const [candidateMae, incumbentMae] = scored.mae;
    const testRows = scored.rows;
    unlinkSync(candidatePath);

    if (!(candidateMae <= incumbentMae)) {
      return { at, ok: true, adopted: false, reason: "candidate did not beat the incumbent on held-out data", incumbentMae, candidateMae, testRows };
    }
    // It wins, so rebuild over the whole history — including the held-out window — and adopt.
    const full = await run(["scripts/learn-timing.ts", "--no-flush", "--out", live]);
    if (full.code !== 0) {
      return { at, ok: false, adopted: false, reason: `final build failed: ${full.out.trim().slice(-200)}`, incumbentMae, candidateMae };
    }
    const adoptedTables = JSON.parse(readFileSync(live, "utf8")) as TimingTables;
    const model = await retrainModel(live);
    return {
      at, ok: true, adopted: true,
      reason: `adopted: ${candidateMae.toFixed(1)}s vs ${incumbentMae.toFixed(1)}s on ${testRows} held-out observations`,
      incumbentMae, candidateMae, testRows, events: adoptedTables.samples.events, model,
    };
  } catch (e) {
    return { at, ok: false, adopted: false, reason: e instanceof Error ? e.message : String(e) };
  } finally {
    conn.closeSync();
    db.closeSync();
  }
}

/**
 * Can this machine retrain the model at all?
 *
 * Probed at start-up rather than discovered at twenty past three in the morning: the trainer needs
 * a Python and three libraries, and an image built without them would simply never improve the
 * model again while reporting that everything was fine.
 */
export async function modelTrainingReady(): Promise<{ ready: boolean; detail: string }> {
  if (process.env.MODEL_TRAINING === "off") return { ready: false, detail: "turned off" };
  const python = process.env.PYTHON ?? "python3";
  return new Promise((resolve) => {
    const p = spawn(python, ["-c", "import sklearn, pandas, numpy, duckdb; print(sklearn.__version__)"], { env: process.env });
    let out = "";
    p.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    p.stderr.on("data", (d: Buffer) => { out += d.toString(); });
    p.on("error", (e) => resolve({ ready: false, detail: String(e).slice(0, 120) }));
    p.on("close", (code) => resolve(
      code === 0 ? { ready: true, detail: `scikit-learn ${out.trim()}` } : { ready: false, detail: out.trim().slice(-120) },
    ));
  });
}

/**
 * Retrain the residual model, and keep it only if it wins.
 *
 * The tables have rebuilt themselves nightly for a while; the model did not — it was trained by
 * hand and shipped as a file, so the largest single contributor after the tables was the one part
 * that never learned anything new. It runs as a separate process on purpose: it needs about a
 * gigabyte for a minute, and a trainer that takes the recorder down with it would cost far more
 * than it could add.
 *
 * It has to clear two bars before anything is written: beat the tables it was built against by
 * more than 2%, and beat the model already in service on the same held-out window. Without the
 * second, a nightly retrain drifts downhill one small step at a time and nobody sees it happen.
 */
async function retrainModel(tablesPath: string): Promise<ModelOutcome> {
  if (process.env.MODEL_TRAINING === "off") return { ran: false, reason: "turned off" };
  const python = process.env.PYTHON ?? "python3";
  const live = join(DATA_DIR, "eta-model.json");
  const candidate = join(DATA_DIR, "eta-model.candidate.json");
  void tablesPath;
  const started = Date.now();
  const out = await new Promise<{ code: number; out: string }>((resolve) => {
    const p = spawn(python, [join(ROOT, "scripts/train_eta_model.py"), "--out", candidate, "--incumbent", live], {
      cwd: ROOT, env: process.env,
    });
    let text = "";
    p.stdout.on("data", (d: Buffer) => { text += d.toString(); });
    p.stderr.on("data", (d: Buffer) => { text += d.toString(); });
    p.on("error", (e) => resolve({ code: -1, out: String(e) }));
    p.on("close", (code) => resolve({ code: code ?? -1, out: text }));
  });
  const took = Math.round((Date.now() - started) / 1000);
  const tail = out.out.trim().split("\n").slice(-1)[0]?.slice(0, 160) ?? "";

  if (out.code === 3 || out.code === 4) return { ran: true, adopted: false, tookS: took, reason: tail };
  if (out.code !== 0 || !existsSync(candidate)) {
    return { ran: true, adopted: false, tookS: took, reason: `training failed: ${tail}` };
  }
  // Atomic: the poller watches this file and reloads it, so it must never be half-written.
  renameSync(candidate, live);
  return { ran: true, adopted: true, tookS: took, reason: tail };
}

/** Milliseconds until the next 03:20 in New York, when the system is quietest. */
export function msUntilNightly(now = new Date()): number {
  const ny = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const target = new Date(ny);
  target.setHours(3, 20, 0, 0);
  if (target <= ny) target.setDate(target.getDate() + 1);
  return target.getTime() - ny.getTime();
}
