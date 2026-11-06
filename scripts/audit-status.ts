/**
 * How often each train status is right, judged by what the train did next.
 *
 * Recorded ticks are replayed through the tracker. Every SNAPSHOT_S of feed time each train's
 * status is noted, and every status that makes a claim is held to it against the arrivals and
 * departures the vehicle itself reported afterwards — the feed's own transitions, independent of
 * the rules being judged:
 *
 *   preparing  the train leaves its first stop at about the trip's start time
 *   held       the train reaches its next stop more than HELD_S late — or leaves the platform
 *              more than HELD_S after it should have
 *   lost       nothing more is reported for it
 *
 * and the misses are counted the other way: segments that ran clearly late and were never called
 * held. Transitions that cannot happen, and statuses that flap, are listed with an example each.
 *
 *   npx tsx scripts/audit-status.ts               # every recorded tick
 *   npx tsx scripts/audit-status.ts --hours 3     # the last three hours
 */
import { DuckDBInstance } from "@duckdb/node-api";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { HELD_S, type Network, type TimingTables, type TrainState, type TrainStatus } from "../src/lib/types";
import { NetworkIndex, parentOf } from "../src/lib/network";
import { Timing } from "../src/lib/timing";
import { Tracker, type StationEvent } from "../src/lib/tracker";
import { loadDecoder } from "../services/poller/feeds";
import { DATA_DIR, parquetGlob } from "../services/poller/recorder";

const ROOT = join(import.meta.dirname, "..");
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) args.set(a.slice(2), process.argv[i + 1]?.startsWith("--") || process.argv[i + 1] === undefined ? "true" : process.argv[++i]);
}
const SNAPSHOT_S = Number(args.get("every") ?? 30);
/** Let the tracker see a few minutes before judging it: everything is "first seen" at the start. */
const WARM_S = 600;

interface Seen { at: number; st: TrainState }

const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : "—");
const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
const mins = (s: number) => `${(s / 60).toFixed(1)} min`;

async function main() {
  const net = new NetworkIndex(JSON.parse(readFileSync(join(ROOT, "public", "data", "network.json"), "utf8")) as Network);
  let tables: TimingTables | null = null;
  try { tables = JSON.parse(readFileSync(join(DATA_DIR, "timing.json"), "utf8")) as TimingTables; } catch { /* scheduled times only */ }
  const tracker = new Tracker(net, new Timing(net, tables));
  const decoder = await loadDecoder();

  const db = await DuckDBInstance.create(":memory:", { threads: "4", memory_limit: "2000MB" });
  const conn = await db.connect();
  const hours = args.get("hours") ? Number(args.get("hours")) : undefined;
  const cutoff = hours ? Math.floor(Date.now() / 1000) - hours * 3600 : 0;
  const result = await conn.stream(
    `SELECT feed, ts::DOUBLE, fetched_at::DOUBLE, raw FROM read_parquet('${parquetGlob("ticks")}', union_by_name=true)
     ${cutoff ? `WHERE fetched_at >= ${cutoff}` : ""} ORDER BY fetched_at, ts, feed`,
  );

  // Ground truth: what each trip's vehicle reported, as the tracker turned it into events.
  const events = new Map<string, StationEvent[]>();
  // Every snapshot of every train, by trip.
  const seen = new Map<string, Seen[]>();
  let from = 0, to = 0, lastSnap = 0, ticks = 0;

  for (;;) {
    const chunk = await result.fetchChunk();
    if (!chunk || chunk.rowCount === 0) break;
    for (const [feed, ts, fetchedAt, raw] of chunk.getRows()) {
      const bytes = raw instanceof Uint8Array ? raw : (raw as { bytes: Uint8Array }).bytes;
      let decoded;
      try { decoded = decoder(gunzipSync(bytes)); } catch { continue; }
      const t = fetchedAt as number;
      from ||= t;
      to = t;
      ticks++;
      const out = tracker.ingest({ feed: feed as string, ts: decoded.ts ?? (ts as number), fetchedAt: t, trains: decoded.trains });
      for (const e of out.events) if (!e.estimated) (events.get(e.tripId) ?? events.set(e.tripId, []).get(e.tripId)!).push(e);
      if (t - lastSnap < SNAPSHOT_S) continue;
      lastSnap = t;
      tracker.expire(t);
      if (t < from + WARM_S) continue;
      for (const st of tracker.states(t, { predictions: false })) (seen.get(st.id) ?? seen.set(st.id, []).get(st.id)!).push({ at: t, st });
    }
  }
  conn.closeSync();
  db.closeSync();
  if (!ticks) { console.error("no recorded ticks to replay"); process.exit(2); }
  // --trace <trip id>: every snapshot of one train, and the events its vehicle reported — the way
  // to see why one example above came out as it did.
  const trace = args.get("trace");
  if (trace) {
    const fmt = (t: number) => new Date(t * 1000).toISOString().slice(11, 19);
    for (const x of seen.get(trace) ?? []) {
      const st = x.st;
      console.log(`${fmt(x.at)} ${st.status.padEnd(11)} ${st.phase.padEnd(9)} ${st.prevStop ?? "-"}>${st.nextStop} dep ${st.departedAt ? fmt(st.departedAt) : "-"} run ${Math.round(st.runTime ?? -1)} held ${Math.round(st.heldFor ?? 0)} inferred ${!!st.prevInferred} etaRaw ${fmt(st.etaRaw)} upd ${fmt(st.updatedAt ?? 0)}`);
    }
    for (const e of events.get(trace) ?? []) console.log(`  event ${fmt(e.ts)} ${e.kind} ${e.stopId}`);
    process.exit(0);
  }
  const nyTime = (s: number) => new Date(s * 1000).toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit", weekday: "short" });
  console.log(`replayed ${ticks} ticks, ${nyTime(from)} to ${nyTime(to)} (${((to - from) / 3600).toFixed(1)} h), a snapshot every ${SNAPSHOT_S} s\n`);

  const firstEvent = (trip: string, stop: string, kind: StationEvent["kind"], after: number) =>
    events.get(trip)?.find((e) => e.kind === kind && parentOf(e.stopId) === parentOf(stop) && e.ts >= after);
  const anyEventAfter = (trip: string, after: number) => events.get(trip)?.some((e) => e.ts > after) ?? false;
  /*
   * Trips that go backwards: a stop already left, reached again later. A trip id reused for a
   * second train, or a trip renumbered, does this, and every outcome matched by trip id is then
   * ambiguous — so these are counted as an edge case of their own and left out of the scoring.
   */
  const backwards = new Set<string>();
  let reused = 0;
  for (const [trip, xs] of seen) {
    const left: string[] = [];
    let lastAt = 0;
    for (const x of xs) {
      // Only stops it was seen to leave: a guessed origin for a train first seen mid-segment is not
      // a position the feed gave, and a guess that lands behind the train is not it going backwards.
      const p = x.st.phase === "moving" && !x.st.prevInferred ? x.st.prevStop : undefined;
      // Gone longer than the tracker keeps a trip and back somewhere it had been: a new run as far as
      // the tracker is concerned — the shuttles reuse a trip id for the next run this way, and a
      // stale republish after a gap looks the same. Counted, not judged.
      if (lastAt && x.at - lastAt > 120) {
        if (x.st.phase === "moving" && x.st.prevStop && left.includes(x.st.prevStop)) reused++;
        left.length = 0;
      }
      lastAt = x.at;
      if (!p || left[left.length - 1] === p) continue;
      if (left.includes(p)) { backwards.add(trip); break; }
      left.push(p);
    }
  }
  // What a backwards trip looks like: whether the MTA's own train id changed where it jumped.
  let renamed = 0, gapped = 0;
  for (const t of backwards) {
    const xs = seen.get(t)!;
    const ids = new Set(xs.map((x) => x.st.trainId ?? ""));
    if (ids.size > 1) renamed++;
    let gap = 0;
    for (let i = 1; i < xs.length; i++) gap = Math.max(gap, xs[i].at - xs[i - 1].at);
    if (gap > 120) gapped++;
  }
  console.log(`backwards trips: ${renamed} of ${backwards.size} changed train id; ${gapped} had a gap of more than 2 min in the feed`);
  if (args.get("backwards")) {
    // Where each backwards trip was before the jump and after it, and what else was where it had been.
    const stopsOf = (xs: Seen[]) => xs.map((x) => x.st.phase === "moving" ? x.st.prevStop : x.st.phase === "dwelling" ? x.st.nextStop : undefined);
    const firstAt = new Map<string, number>();
    for (const [t, xs] of seen) firstAt.set(t, xs[0].at);
    let continued = 0, finishedSecond = 0, n = 0;
    const gaps: number[] = [], back: number[] = [];
    for (const t of backwards) {
      // The tracker's own corrections are accounted for; these are the ones that are not.
      if (tracker.regressions.accepted.has(t)) continue;
      const xs = seen.get(t)!;
      const st = stopsOf(xs);
      const left: string[] = [];
      let j = -1;
      for (let i = 0; i < xs.length; i++) {
        const p = st[i];
        if (!p || left[left.length - 1] === p) continue;
        if (left.includes(p)) { j = i; break; }
        left.push(p);
      }
      if (j < 1) continue;
      n++;
      const before = xs[j - 1], after = xs[j];
      gaps.push(after.at - before.at);
      back.push(left.length - left.indexOf(st[j]!));
      // Another trip first seen near the jump, at or just past where this one had got to.
      const here = parentOf(before.st.nextStop);
      const other = [...seen].find(([o, ys]) => o !== t && Math.abs(firstAt.get(o)! - after.at) < 600 && ys.some((y) => Math.abs(y.at - after.at) < 300 && (parentOf(y.st.nextStop) === here || parentOf(y.st.prevStop ?? "") === here)));
      if (other) continued++;
      // Does the second pass get further than the first did?
      if (left.length < new Set(st.filter(Boolean)).size) finishedSecond++;
      if (n <= 6) console.log(`  ${t}: at ${before.st.prevStop ?? "-"}>${before.st.nextStop} ${nyTime(before.at)}, then ${after.st.prevStop ?? "-"}>${after.st.nextStop} ${nyTime(after.at)} — gap ${Math.round(after.at - before.at)} s${other ? `; ${other[0]} appeared where it had been` : ""}`);
    }
    console.log(`  of ${n}: gap before the jump median ${Math.round(q(gaps, 0.5))} s; jumped back a median ${q(back, 0.5)} stops; another trip appeared where it had been in ${continued}; the second pass went further in ${finishedSecond}`);
    process.exit(0);
  }
  const traced = args.get("trace");
  for (const t of backwards) if (t !== traced) seen.delete(t);
  // Judging needs time for the outcome to happen: a claim made in the last 20 minutes is not scored.
  const judgeable = (at: number) => at < to - 1200;

  // ---- how much of each ----
  const totals = new Map<TrainStatus, number>();
  for (const xs of seen.values()) for (const x of xs) totals.set(x.st.status, (totals.get(x.st.status) ?? 0) + 1);
  const all = [...totals.values()].reduce((a, b) => a + b, 0);
  console.log(`feed placed a trip somewhere it had already left: ${tracker.regressions.ignored.size} trips ignored as a glitch, ${tracker.regressions.accepted.size} accepted once it persisted`);
  console.log(`back after more than 2 min, behind where last seen (a new run to the tracker): ${reused}`);
  const corrected = [...backwards].filter((t) => tracker.regressions.accepted.has(t)).length;
  console.log(`went backwards because the tracker corrected a forward glitch: ${corrected}; unexplained: ${backwards.size - corrected}`);
  console.log(`trips that went backwards (left out of the scoring): ${backwards.size}${backwards.size ? `, e.g. ${[...backwards][0]}` : ""}\n`);
  console.log("share of train-snapshots");
  for (const [s, n] of [...totals].sort((a, b) => b[1] - a[1])) console.log(`  ${s.padEnd(12)} ${pct(n, all).padStart(6)}`);

  // ---- preparing: did it leave its first stop at the trip's start? ----
  const prepErr: number[] = []; let prepN = 0, prepNever = 0, prepUnrecorded = 0;
  const prepEx: string[] = [], prepNeverEx: string[] = [];
  for (const [trip, xs] of seen) {
    const first = xs.find((x) => x.st.status === "preparing");
    // Judged only where its start was well inside the window: a train can be made ready an hour ahead.
    if (!first || (first.st.startsAt ?? Infinity) > to - 900) continue;
    prepN++;
    const stop = first.st.nextStop;
    const left = firstEvent(trip, stop, "depart", first.at - 60) ?? firstEvent(trip, stop, "arrive", first.at - 60);
    if (left) { prepErr.push(left.ts - (first.st.startsAt ?? left.ts)); continue; }
    // In service later with no event recorded at that stop: it left without the feed saying when.
    const later = xs.find((x) => x.at > first.at && (x.st.status === "running" || x.st.status === "at-platform" || x.st.status === "held"));
    if (later) {
      prepUnrecorded++;
      if (prepEx.length < 3) prepEx.push(`${trip}: parked at ${stop}, next seen in service at ${later.st.prevStop ?? later.st.nextStop}`);
    } else {
      prepNever++;
      const last = xs[xs.length - 1];
      if (prepNeverEx.length < 3) prepNeverEx.push(`${trip}: preparing at ${stop} to start ${nyTime(first.st.startsAt ?? 0)}; last seen ${nyTime(last.at)} as ${last.st.status}`);
    }
  }
  console.log(`\npreparing — ${prepN} trains`);
  console.log(`  left the stop it was parked at        ${pct(prepErr.length, prepN)}`);
  console.log(`    against its start time: median ${mins(q(prepErr, 0.5))}, 10th–90th ${mins(q(prepErr, 0.1))} to ${mins(q(prepErr, 0.9))}`);
  console.log(`    within ±2 min of it                  ${pct(prepErr.filter((e) => Math.abs(e) <= 120).length, prepErr.length)}`);
  console.log(`  in service later, no departure on record ${pct(prepUnrecorded, prepN)}${prepEx.length ? `   e.g. ${prepEx[0]}` : ""}`);
  console.log(`  never went into service               ${pct(prepNever, prepN)}`);
  for (const e of prepNeverEx) console.log(`    e.g. ${e}`);

  // ---- held, between stations: did it arrive late? ----
  let heldN = 0, heldRight = 0, heldUnknown = 0;
  const heldLead: number[] = []; const heldWrong: string[] = [];
  // The numbered lines and the lettered ones report a departure differently, so they are judged apart.
  const division = (route: string) => (/^([1-7]|GS)/.test(route) ? "numbered" : "lettered");
  const plat = { numbered: { n: 0, right: 0, unknown: 0 }, lettered: { n: 0, right: 0, unknown: 0 } };
  const platWrong: string[] = [];
  for (const [trip, xs] of seen) {
    let flagged = "";
    for (const x of xs) {
      if (x.st.status !== "held") continue;
      const key = `${x.st.phase}|${x.st.prevStop}>${x.st.nextStop}`;
      if (key === flagged || !judgeable(x.at)) continue;
      flagged = key;
      if (x.st.phase === "moving") {
        heldN++;
        const arr = firstEvent(trip, x.st.nextStop, "arrive", x.st.departedAt ?? x.at - 3600);
        if (!arr) { heldUnknown++; continue; }
        const late = arr.ts - (x.st.departedAt ?? 0) - (x.st.runTime ?? 0);
        if (late > HELD_S) { heldRight++; heldLead.push(arr.ts - x.at); }
        else if (heldWrong.length < 3) heldWrong.push(`${trip} ${x.st.prevStop}>${x.st.nextStop}: flagged ${Math.round(x.st.heldFor ?? 0)} s late, arrived ${Math.round(late)} s late`);
      } else {
        const d = plat[division(x.st.route)];
        d.n++;
        const dep = firstEvent(trip, x.st.nextStop, "depart", x.st.arrivedAt ?? x.at - 3600);
        if (!dep) { d.unknown++; continue; }
        const late = dep.ts - (x.st.expectedDeparture ?? dep.ts);
        if (late > HELD_S) d.right++;
        else if (platWrong.length < 3) platWrong.push(`${trip} at ${x.st.nextStop}: flagged ${Math.round(x.st.heldFor ?? 0)} s past due, left ${Math.round(late)} s after due`);
      }
    }
  }
  console.log(`\nheld between stations — ${heldN} episodes`);
  console.log(`  arrived more than ${HELD_S} s late         ${pct(heldRight, heldN - heldUnknown)} of the ${heldN - heldUnknown} with an arrival on record`);
  console.log(`    flagged this long before arriving: median ${mins(q(heldLead, 0.5))}`);
  for (const w of heldWrong) console.log(`  wrong: ${w}`);
  for (const [name, d] of Object.entries(plat)) {
    console.log(`held at a platform, ${name} lines — ${d.n} episodes`);
    console.log(`  left more than ${HELD_S} s after due        ${pct(d.right, d.n - d.unknown)} of the ${d.n - d.unknown} with a departure on record`);
  }
  for (const w of platWrong) console.log(`  wrong: ${w}`);

  // ---- held, the other way: segments that ran clearly late. Were they called? ----
  let lateSegs = 0, lateCalled = 0; const missed: string[] = [];
  for (const [trip, xs] of seen) {
    for (const x of xs) {
      if (x.st.phase !== "moving" || x.st.prevInferred || x.st.departedAt === undefined || x.st.runTime === undefined) continue;
      // Each segment once, judged from its first snapshot.
      if (xs.findIndex((y) => y.st.prevStop === x.st.prevStop && y.st.nextStop === x.st.nextStop && y.st.phase === "moving") !== xs.indexOf(x)) continue;
      const arr = firstEvent(trip, x.st.nextStop, "arrive", x.st.departedAt);
      if (!arr || !judgeable(arr.ts)) continue;
      const late = arr.ts - x.st.departedAt - x.st.runTime;
      if (late < HELD_S + 60) continue;   // clearly late, with a minute's margin past the line
      lateSegs++;
      const called = xs.some((y) => y.at < arr.ts && y.st.status === "held" && y.st.nextStop === x.st.nextStop);
      if (called) lateCalled++;
      else if (missed.length < 3) missed.push(`${trip} ${x.st.prevStop}>${x.st.nextStop}: ${Math.round(late)} s late, never called held`);
    }
  }
  console.log(`\nsegments that ran more than ${HELD_S + 60} s late — ${lateSegs}`);
  console.log(`  called held before arriving             ${pct(lateCalled, lateSegs)}`);
  for (const m of missed) console.log(`  missed: ${m}`);

  // ---- lost: did it come back? ----
  let lostN = 0, lostBack = 0; const back: string[] = [];
  for (const [trip, xs] of seen) {
    const first = xs.find((x) => x.st.status === "lost");
    if (!first || !judgeable(first.at)) continue;
    lostN++;
    if (anyEventAfter(trip, first.at + 60)) {
      lostBack++;
      if (back.length < 3) back.push(`${trip}: lost at ${first.st.nextStop} (${first.st.phase}), reported moving again after`);
    }
  }
  console.log(`\nlost — ${lostN} trains`);
  console.log(`  reported again afterwards               ${pct(lostBack, lostN)}`);
  for (const b of back) console.log(`  e.g. ${b}`);

  // ---- transitions that should not happen, and statuses that flap ----
  const moves = new Map<string, { n: number; example: string }>();
  let flaps = 0; const flapEx: string[] = [];
  for (const [trip, xs] of seen) {
    for (let i = 1; i < xs.length; i++) {
      const a = xs[i - 1].st.status, b = xs[i].st.status;
      if (a === b) continue;
      const k = `${a} → ${b}`;
      const m = moves.get(k) ?? { n: 0, example: `${trip} at ${xs[i].st.nextStop}, ${nyTime(xs[i].at)}` };
      m.n++;
      moves.set(k, m);
      // There and straight back within two snapshots — among the statuses that make a claim. A train
      // going stop to stop is at-platform and running by turns, and that is not a flap.
      const claim = (x: TrainStatus) => x !== "running" && x !== "at-platform";
      const where = (k: number) => `${xs[k].st.prevStop}>${xs[k].st.nextStop}`;
      if (i >= 2 && (claim(a) || claim(b)) && where(i) === where(i - 2) && xs[i - 2].st.status === b && xs[i].at - xs[i - 2].at <= 2 * SNAPSHOT_S + 5) {
        flaps++;
        if (flapEx.length < 3) flapEx.push(`${trip}: ${b} → ${a} → ${b} at ${xs[i].st.nextStop}`);
      }
    }
  }
  // What a train's day can look like: scheduled → preparing → at-platform/running ⇄ held → (gone), lost from anywhere.
  const expected = new Set([
    "scheduled → preparing", "scheduled → running", "scheduled → at-platform", "preparing → running", "preparing → at-platform",
    "at-platform → running", "running → at-platform", "running → held", "held → running", "at-platform → held", "held → at-platform",
    "running → lost", "at-platform → lost", "held → lost", "lost → running", "lost → at-platform", "preparing → scheduled",
  ]);
  console.log(`\nstatus changes`);
  for (const [k, m] of [...moves].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`  ${expected.has(k) ? " " : "!"} ${String(m.n).padStart(6)}  ${k.padEnd(28)}${expected.has(k) ? "" : `  e.g. ${m.example}`}`);
  }
  console.log(`  flapping (A → B → A on one segment, within ${2 * SNAPSHOT_S} s): ${flaps}${flapEx.length ? `   e.g. ${flapEx[0]}` : ""}`);
}

main().catch((e) => { console.error(e); process.exit(2); });
