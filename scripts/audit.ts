/**
 * Correctness audit. Reads the live state (or a saved snapshot) and asserts the invariants the
 * August 2026 audit had to discover by hand. Exits non-zero on any violation, so it can gate a
 * deploy rather than waiting for someone to notice something odd on the map.
 *
 *   npm run audit                      # against the local poller
 *   npm run audit -- --url https://…   # against a deployed one
 *   npm run audit -- --state file.json # against a saved snapshot
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Network, StateSnapshot, TrainState } from "../src/lib/types";
import { NetworkIndex, parentOf } from "../src/lib/network";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) args.set(a.slice(2), process.argv[i + 1]?.startsWith("--") || process.argv[i + 1] === undefined ? "true" : process.argv[++i]);
}
const ROOT = join(import.meta.dirname, "..");

interface Finding { severity: "high" | "medium" | "low"; rule: string; detail: string; count: number }

function audit(net: NetworkIndex, snap: StateSnapshot): Finding[] {
  const now = snap.ts;
  const hits = new Map<string, { severity: Finding["severity"]; examples: string[]; count: number }>();
  const flag = (severity: Finding["severity"], rule: string, example: string) => {
    const e = hits.get(rule) ?? { severity, examples: [], count: 0 };
    e.count++;
    if (e.examples.length < 3) e.examples.push(example);
    hits.set(rule, e);
  };
  const known = (id: string) => !!net.station(id);

  for (const t of snap.trains as TrainState[]) {
    const who = `${t.route} ${t.id.slice(0, 22)}`;
    if (!net.net.routes[t.route]) flag("high", "route not in the schedule", `${t.route} (${t.id.slice(0, 22)})`);
    if (!known(t.nextStop)) flag("high", "next stop not in the schedule", `${who} -> ${t.nextStop}`);
    if (t.destination && !known(t.destination)) flag("medium", "terminal not in the schedule", `${who} -> ${t.destination}`);
    for (const s of t.stops) if (!known(s.id)) flag("medium", "predicted stop not in the schedule", `${who} @ ${s.id}`);

    for (let i = 1; i < t.stops.length; i++) {
      if (t.stops[i].eta < t.stops[i - 1].eta - 1) {
        flag("high", "predicted stop times run backwards", `${who} ${t.stops[i - 1].id}->${t.stops[i].id} by ${Math.round(t.stops[i - 1].eta - t.stops[i].eta)}s`);
        break;
      }
    }

    // A dwelling train's `eta` is when it arrived, not a forecast, so only a moving train can
    // have an arrival stuck in the past. A parked one is caught by the staleness rule instead.
    if (t.phase === "moving" && t.eta < now - 600) flag("high", "arrival predicted far in the past", `${who} ${Math.round((now - t.eta) / 60)}min stale`);
    if (t.phase === "dwelling" && t.arrivedAt && now - t.arrivedAt > 1800 && !t.stale) {
      flag("high", "parked at a platform beyond any real layover, and not flagged", `${who} ${Math.round((now - t.arrivedAt) / 60)}min`);
    }
    if (t.eta > now + 7200) flag("medium", "arrival predicted absurdly far ahead", `${who} ${Math.round((t.eta - now) / 60)}min`);
    if (t.sigma < 0 || t.sigma > 900) flag("medium", "uncertainty out of range", `${who} sigma ${Math.round(t.sigma)}`);
    if (t.arrivedAt && t.arrivedAt > now + 5) flag("medium", "arrived in the future", who);
    if (t.phase === "moving" && t.prevStop && parentOf(t.prevStop) === parentOf(t.nextStop)) flag("medium", "moving between one stop and itself", who);
    if (t.runTime !== undefined && (t.runTime < 5 || t.runTime > 1800)) flag("low", "implausible run time", `${who} ${Math.round(t.runTime)}s`);
    if (t.stale) flag("low", "train the feed has stopped updating", who);
    // A drawn train must run between two stops its own route serves, unless it is a reroute the
    // feed is telling us about — those are real, so they are reported quietly rather than failed.
    if (t.phase === "moving" && t.prevStop) {
      const a = parentOf(t.prevStop), b = parentOf(t.nextStop);
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      if (a !== b && !(net.net.routeSegments[t.route] ?? []).includes(key)) {
        flag("low", "running off its scheduled pattern (reroute, or a gap in the schedule)", `${who} ${net.stationName(a)}->${net.stationName(b)}`);
      }
    }
  }

  const dup = new Map<string, number>();
  for (const t of snap.trains) if (t.trainId) dup.set(t.trainId, (dup.get(t.trainId) ?? 0) + 1);
  for (const [id, n] of dup) if (n > 1) flag("high", "one physical train drawn more than once", `${id} x${n}`);

  return [...hits.entries()]
    .map(([rule, e]) => ({ severity: e.severity, rule, detail: e.examples.join(" ; "), count: e.count }))
    .sort((a, b) => ({ high: 0, medium: 1, low: 2 })[a.severity] - ({ high: 0, medium: 1, low: 2 })[b.severity] || b.count - a.count);
}

async function main() {
  const net = new NetworkIndex(JSON.parse(readFileSync(join(ROOT, "public", "data", "network.json"), "utf8")) as Network);
  const stateArg = args.get("state");
  let snap: StateSnapshot;
  if (stateArg && existsSync(stateArg)) {
    snap = JSON.parse(readFileSync(stateArg, "utf8")) as StateSnapshot;
  } else {
    const url = `${args.get("url") ?? "http://localhost:7118"}/state`;
    const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(30_000) });
    if (!res.ok) { console.error(`could not read ${url}: HTTP ${res.status}`); process.exit(2); }
    snap = (await res.json()) as StateSnapshot;
  }

  const findings = audit(net, snap);
  const highs = findings.filter((f) => f.severity === "high");
  const mediums = findings.filter((f) => f.severity === "medium");

  console.log(`audited ${snap.trains.length} trains at ${new Date(snap.ts * 1000).toLocaleString("en-US", { timeZone: "America/New_York" })}\n`);
  if (findings.length === 0) console.log("  no violations");
  for (const f of findings) {
    console.log(`  [${f.severity.padEnd(6)}] ${String(f.count).padStart(4)}  ${f.rule}`);
    console.log(`            ${f.detail}`);
  }
  // Low-severity findings are facts about the feed (reroutes, stalled trains) rather than defects,
  // so they are reported but do not fail the run.
  const failed = highs.length + mediums.length;
  console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${highs.length} high, ${mediums.length} medium, ${findings.length - failed} informational`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
