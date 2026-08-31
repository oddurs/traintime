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
import type { Network, StateSnapshot } from "../src/lib/types";
import { NetworkIndex } from "../src/lib/network";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) args.set(a.slice(2), process.argv[i + 1]?.startsWith("--") || process.argv[i + 1] === undefined ? "true" : process.argv[++i]);
}
const ROOT = join(import.meta.dirname, "..");

import { checkInvariants, isFailure } from "../src/lib/invariants";

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

  const findings = checkInvariants(net, snap.trains, snap.ts);
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
  const failed = findings.filter(isFailure).length;
  console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${highs.length} high, ${mediums.length} medium, ${findings.length - failed} informational`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
