/**
 * Score the engine across the five windows a day actually has, rather than whichever slice was
 * convenient.
 *
 * Every accuracy decision in this codebase up to now was judged on one window, usually a PM rush
 * or an evening. That is the window where the system behaves best: overnight the MTA's own error
 * is several times its daytime figure, service is sparse and half the lines are rerouted for
 * track work. A change that helps at 5pm and hurts at 3am is not an improvement, and until now
 * nothing would have told us.
 *
 * Usage: npx tsx scripts/evaluate-windows.ts [--variant kinematic] [--timing x] [--model y]
 *                                            [--day YYYY-MM-DD] [--windows am,pm]
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";

const ROOT = join(import.meta.dirname, "..");
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) args.set(a.slice(2), process.argv[i + 1]?.startsWith("--") || process.argv[i + 1] === undefined ? "true" : process.argv[++i]);
}

/** New York local hours, because that is when the service changes character. */
const WINDOWS: { id: string; label: string; from: number; to: number }[] = [
  { id: "owl", label: "overnight", from: 1, to: 5 },
  { id: "am", label: "am peak", from: 7, to: 10 },
  { id: "midday", label: "midday", from: 11, to: 14 },
  { id: "pm", label: "pm peak", from: 16, to: 19 },
  { id: "eve", label: "evening", from: 20, to: 23 },
];

/** The New York offset for a given instant, from the runtime's own tz database. */
function nyOffsetHours(atMs: number): number {
  const s = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "shortOffset" })
    .formatToParts(new Date(atMs)).find((p) => p.type === "timeZoneName")?.value ?? "GMT-5";
  return Number(/GMT([+-]\d+)/.exec(s)?.[1] ?? -5);
}

async function main() {
  const db = await DuckDBInstance.create(":memory:");
  const conn = await db.connect();
  const bounds = (await conn.runAndReadAll(
    `SELECT min(fetched_at) AS lo, max(fetched_at) AS hi FROM read_parquet('${join(ROOT, "data/rec/ticks/*.parquet")}', union_by_name=true)`,
  )).getRowObjects()[0] as { lo: bigint; hi: bigint };
  conn.closeSync(); db.closeSync();
  const lo = Number(bounds.lo), hi = Number(bounds.hi);
  if (!Number.isFinite(lo)) { console.error("no recordings to score"); process.exit(1); }

  const off = nyOffsetHours(hi * 1000);
  /** Midnight in New York on the day the recordings end. */
  const today = Math.floor((hi + off * 3600) / 86_400) * 86_400 - off * 3600;
  /**
   * The most recent time each window actually happened inside what we recorded. Anchoring on
   * "today" alone scores nothing for the windows that have not come round yet — at one in the
   * morning that is three of the five, which is how a "full day" report ends up being two rows.
   */
  const mostRecent = (w: { from: number; to: number }) => {
    for (const day of [today, today - 86_400, today - 2 * 86_400]) {
      const from = day + w.from * 3600, to = day + w.to * 3600;
      if (to <= lo || from >= hi) continue;
      // Only take a window we have a decent share of; a sliver scores noise.
      if (Math.min(to, hi) - Math.max(from, lo) < (to - from) * 0.5) continue;
      return { from: Math.max(from, lo), to: Math.min(to, hi) };
    }
    return null;
  };

  const only = args.get("windows")?.split(",");
  const pass = ["variant", "timing", "model", "no-timing"].flatMap((k) => (args.has(k) ? [`--${k}`, args.get(k)!] : []));

  interface Row { window: string; hours: string; n: number; report: Record<string, unknown> }
  const rows: Row[] = [];
  for (const w of WINDOWS) {
    if (only && !only.includes(w.id)) continue;
    const span = mostRecent(w);
    // A window we have no recordings for is skipped rather than reported as a zero.
    if (!span) { console.log(`  ${w.label.padEnd(10)} — no recordings`); continue; }
    const a = span.from, b = span.to;
    const name = `win-${w.id}`;
    process.stdout.write(`  ${w.label.padEnd(10)} scoring ${new Date(a * 1000).toISOString().slice(11, 16)}–${new Date(b * 1000).toISOString().slice(11, 16)}Z … `);
    const started = Date.now();
    try {
      execFileSync("npx", ["tsx", join(ROOT, "scripts/evaluate.ts"), "--no-flush", "--from", String(a), "--to", String(b), "--name", name, ...pass],
        { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    } catch (e) {
      console.log(`failed: ${String((e as { stderr?: Buffer }).stderr ?? e).slice(-160)}`);
      continue;
    }
    const path = join(ROOT, "data", "eval", `${name}.json`);
    if (!existsSync(path)) { console.log("no report"); continue; }
    const report = JSON.parse(readFileSync(path, "utf8"));
    rows.push({ window: w.label, hours: `${w.from}–${w.to}`, n: report.arrivals ?? 0, report });
    console.log(`${((Date.now() - started) / 1000).toFixed(0)}s`);
  }

  const f1 = (x: unknown) => (typeof x === "number" ? x.toFixed(1) : "—");
  const f0 = (x: unknown) => (typeof x === "number" ? Math.round(x).toString() : "—");
  const pct = (x: unknown) => (typeof x === "number" ? `${Math.round(x * 100)}%` : "—");
  const get = (r: Row, path: string[]) => path.reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], r.report);

  console.log(`\n## the day, by window\n`);
  console.log("| window | hours | arrivals | marker short | 45 s–2 min | 2–5 min | 5–15 min | 1σ coverage |");
  console.log("|---|---|---|---|---|---|---|---|");
  for (const r of rows) {
    console.log(
      `| ${r.window} | ${r.hours} | ${f0(r.n)} | ${f0(get(r, ["position", "shortMedianM"]))} m | ` +
      `${f1(get(r, ["eta", "h1", "adjMae"]))} s | ${f1(get(r, ["eta", "h2", "adjMae"]))} s | ` +
      `${f1(get(r, ["eta", "h3", "adjMae"]))} s | ${pct(get(r, ["eta", "h2", "coverage"]))} |`,
    );
  }
  console.log(`\n| window | MTA 2–5 min | ours 2–5 min | reversals |`);
  console.log("|---|---|---|---|");
  for (const r of rows) {
    console.log(`| ${r.window} | ${f1(get(r, ["eta", "h2", "rawMae"]))} s | ${f1(get(r, ["eta", "h2", "adjMae"]))} s | ${f0(get(r, ["motion", "reversals"]))} |`);
  }
  console.log("");
}

main();
