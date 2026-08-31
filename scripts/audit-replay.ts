/**
 * Replay audit. Runs recorded feed history back through the tracker and evaluates the invariants
 * at intervals, reporting violations by hour. A live audit only ever sees this minute; the hours
 * that break assumptions — the overnight reroutes, the 3 am schedule change, the first trains of
 * the morning — are already recorded and can be examined deliberately.
 *
 *   npm run audit:replay                       # everything on disk
 *   npm run audit:replay -- --hours 6          # the last six hours
 */
import { DuckDBInstance } from "@duckdb/node-api";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import type { Network, TimingTables } from "../src/lib/types";
import { NetworkIndex } from "../src/lib/network";
import { Timing } from "../src/lib/timing";
import { Tracker } from "../src/lib/tracker";
import { checkInvariants, isFailure, type Violation } from "../src/lib/invariants";
import { loadDecoder } from "../services/poller/feeds";
import { parquetGlob } from "../services/poller/recorder";

const ROOT = join(import.meta.dirname, "..");
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) args.set(a.slice(2), process.argv[i + 1]?.startsWith("--") || process.argv[i + 1] === undefined ? "true" : process.argv[++i]);
}
/** How often to stop and check, in seconds of replayed time. */
const EVERY = Number(args.get("every") ?? 120);

const nyHour = (ts: number) =>
  new Date(ts * 1000).toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: true, weekday: "short" });

async function main() {
  const net = new NetworkIndex(JSON.parse(readFileSync(join(ROOT, "public", "data", "network.json"), "utf8")) as Network);
  let tables: TimingTables | null = null;
  try { tables = JSON.parse(readFileSync(join(ROOT, "data", "timing.json"), "utf8")) as TimingTables; } catch {}
  const tracker = new Tracker(net, new Timing(net, tables));
  const decoder = await loadDecoder();

  const db = await DuckDBInstance.create(":memory:");
  const conn = await db.connect();
  const hours = args.get("hours") ? Number(args.get("hours")) : undefined;
  const cutoff = hours ? Math.floor(Date.now() / 1000) - hours * 3600 : 0;
  const rows = (await conn.runAndReadAll(
    `SELECT feed, ts, fetched_at, raw FROM read_parquet('${parquetGlob("ticks")}', union_by_name=true)
     ${cutoff ? `WHERE fetched_at >= ${cutoff}` : ""} ORDER BY fetched_at, ts, feed`,
  )).getRowObjects() as { feed: string; ts: bigint; fetched_at: bigint; raw: { bytes: Uint8Array } | Uint8Array }[];
  if (rows.length === 0) { console.error("no recorded ticks to replay"); process.exit(2); }

  const from = Number(rows[0].fetched_at), to = Number(rows[rows.length - 1].fetched_at);
  console.log(`replaying ${rows.length} ticks, ${nyHour(from)} to ${nyHour(to)} (${((to - from) / 3600).toFixed(1)} h), checking every ${EVERY}s\n`);

  const byHour = new Map<string, Map<string, { severity: Violation["severity"]; count: number; example: string }>>();
  let checks = 0, lastCheck = 0, warmedAt = from + 180;

  for (const r of rows) {
    const bytes = r.raw instanceof Uint8Array ? r.raw : r.raw.bytes;
    let decoded;
    try { decoded = decoder(gunzipSync(bytes)); } catch { continue; }
    const t = Number(r.fetched_at);
    tracker.ingest({ feed: r.feed, ts: decoded.ts, fetchedAt: t, trains: decoded.trains });
    if (t < warmedAt || t - lastCheck < EVERY) continue;   // let history build before judging
    lastCheck = t;
    tracker.expire(t);
    checks++;
    const hour = nyHour(t);
    const bucket = byHour.get(hour) ?? byHour.set(hour, new Map()).get(hour)!;
    for (const v of checkInvariants(net, tracker.states(t), t)) {
      const e = bucket.get(v.rule) ?? { severity: v.severity, count: 0, example: v.detail };
      e.count += v.count;
      bucket.set(v.rule, e);
    }
  }

  const totals = new Map<string, { severity: Violation["severity"]; count: number; example: string }>();
  console.log("hour                     failures  informational");
  for (const [hour, rules] of byHour) {
    let fail = 0, info = 0;
    for (const [rule, e] of rules) {
      (isFailure({ severity: e.severity } as Violation) ? (fail += e.count) : (info += e.count));
      const t = totals.get(rule) ?? { severity: e.severity, count: 0, example: e.example };
      t.count += e.count;
      totals.set(rule, t);
    }
    console.log(`${hour.padEnd(24)} ${String(fail).padStart(8)}  ${String(info).padStart(13)}`);
  }

  console.log(`\nacross ${checks} checks:`);
  const rank = { high: 0, medium: 1, low: 2 } as const;
  const sorted = [...totals.entries()].sort((a, b) => rank[a[1].severity] - rank[b[1].severity] || b[1].count - a[1].count);
  if (sorted.length === 0) console.log("  no violations");
  for (const [rule, e] of sorted) {
    console.log(`  [${e.severity.padEnd(6)}] ${String(e.count).padStart(6)}  ${rule}`);
    console.log(`             e.g. ${e.example}`);
  }
  const failures = sorted.filter(([, e]) => isFailure({ severity: e.severity } as Violation));
  console.log(`\n${failures.length === 0 ? "PASS" : "FAIL"} — ${failures.length} failing rule(s) over ${((to - from) / 3600).toFixed(1)} h`);
  conn.closeSync(); db.closeSync();
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
