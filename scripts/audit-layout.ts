/**
 * The line engine's contract, checked.
 *
 * Every clause here was a defect once. Ordering drifted, bands stepped sideways instead of
 * sweeping, crossings were flat, spacing changed with zoom, trains sat beside their own lines,
 * and a standing train sat in the middle of the corridor. A contract nobody checks is a comment.
 *
 * Usage: npx tsx scripts/audit-layout.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NetworkIndex, TRACK_M, fanAt, metresPerPixel } from "../src/lib/network";
import { Kinematics } from "../src/lib/kinematics";
import { distM } from "../src/lib/geo";
import type { LonLat, Network, StopPrediction, TrainState } from "../src/lib/types";

const ROOT = join(import.meta.dirname, "..");
const net = JSON.parse(readFileSync(join(ROOT, "public/data/network.json"), "utf8")) as Network;

interface Finding { clause: string; detail: string }
const findings: Finding[] = [];
const notes: string[] = [];
const fail = (clause: string, detail: string) => findings.push({ clause, detail });

// ---- cheap ----------------------------------------------------------------
const t0 = performance.now();
const idx = new NetworkIndex(net);
const strokes: { route: string; stops: string[]; geom: LonLat[] }[] = [];
for (const [route, runs] of Object.entries(net.routeRuns)) {
  for (const run of runs) {
    const geom: LonLat[] = [];
    for (let i = 0; i + 1 < run.stops.length; i++) {
      const piece = idx.lineSegment(route, run.stops[i], run.stops[i + 1]);
      if (!piece) continue;
      for (const p of piece) {
        const last = geom[geom.length - 1];
        if (!last || last[0] !== p[0] || last[1] !== p[1]) geom.push(p);
      }
    }
    if (geom.length > 1) strokes.push({ route, stops: run.stops, geom });
  }
}
const layoutMs = performance.now() - t0;
const points = strokes.reduce((n, s) => n + s.geom.length, 0);
notes.push(`laid out ${strokes.length} strokes and ${points.toLocaleString()} points in ${layoutMs.toFixed(0)} ms`);
// Generous, but it would catch an accidental quadratic or a lost cache.
if (layoutMs > 250) fail("cheap", `laying out the network took ${layoutMs.toFixed(0)} ms`);

// ---- ordered --------------------------------------------------------------
const seenOrder = new Map<string, Set<number>>();
for (const slots of Object.values(net.segmentSlots)) {
  const rs = Object.keys(slots).sort();
  for (let i = 0; i < rs.length; i++) {
    for (let j = i + 1; j < rs.length; j++) {
      const sign = Math.sign(slots[rs[i]]![0] - slots[rs[j]]![0]);
      const k = `${rs[i]}|${rs[j]}`;
      (seenOrder.get(k) ?? seenOrder.set(k, new Set()).get(k)!).add(sign);
    }
  }
}
const flips = [...seenOrder].filter(([, s]) => s.size > 1);
notes.push(`${seenOrder.size} service pairs share a corridor`);
if (flips.length) fail("ordered", `${flips.length} pairs swap sides between corridors: ${flips.slice(0, 4).map(([k]) => k).join(", ")}`);

// ---- intertwined ----------------------------------------------------------
const zOf = (band: number) => Math.max(0, Math.min(4, Math.round(band + 2)));
let clashes = 0;
for (const slots of Object.values(net.segmentSlots)) {
  const bands = Object.values(slots).map(([b]) => b).sort((a, b) => a - b);
  for (let i = 0; i + 1 < bands.length; i++) if (zOf(bands[i]) === zOf(bands[i + 1])) clashes++;
}
if (clashes) fail("intertwined", `${clashes} places where neighbouring bands share a draw level, so a crossing cannot show`);
for (const runs of Object.values(net.routeRuns)) {
  for (const run of runs) {
    if (run.z !== zOf(run.slot)) { fail("intertwined", `a stroke's draw level does not follow its band`); break; }
  }
}

// ---- separated and conjoined ---------------------------------------------
let joints = 0, worstJoint = 0, wideJoints = 0;
for (const a of strokes) {
  for (const b of strokes) {
    if (a === b || a.route !== b.route) continue;
    if (a.stops[a.stops.length - 1] !== b.stops[0]) continue;
    const gap = distM(a.geom[a.geom.length - 1], b.geom[0]);
    joints++;
    worstJoint = Math.max(worstJoint, gap);
    // A band is 4.6 m; anything approaching that is a step rather than a sweep.
    if (gap > 2) wideJoints++;
  }
}
notes.push(`${joints} band changes · worst gap ${worstJoint.toFixed(2)} m · over 2 m: ${wideJoints}`);
// Half a band. Beyond that a change of band has stepped rather than swept.
if (worstJoint > TRACK_M / 2) fail("conjoined", `two strokes of one service part by ${worstJoint.toFixed(1)} m`);
if (wideJoints) fail("conjoined", `${wideJoints} of ${joints} band changes part by more than 2 m`);

// ---- no stroke has a step in the middle of it -----------------------------
//
// Each stroke is several stretches concatenated, and consecutive stretches share a station: the
// end of one and the start of the next must be the same point. They are not if a stretch is drawn
// on the wrong side of its corridor — which is what happens when a band is applied without the
// stretch's orientation, mirroring it. That was true of a fifth of the network once, and none of
// the other clauses here could see it, because a mirrored stretch still joins its neighbours at
// the *ends* of a stroke.
let seams = 0, worstSeam = 0;
for (const [route, runs] of Object.entries(net.routeRuns)) {
  for (const run of runs) {
    for (let i = 0; i + 2 < run.stops.length; i++) {
      const a = idx.lineSegment(route, run.stops[i], run.stops[i + 1]);
      const b = idx.lineSegment(route, run.stops[i + 1], run.stops[i + 2]);
      if (!a?.length || !b?.length) continue;
      seams++;
      worstSeam = Math.max(worstSeam, distM(a[a.length - 1], b[0]));
    }
  }
}
notes.push(`${seams} seams inside strokes · worst ${worstSeam.toFixed(2)} m`);
// A mirrored stretch steps by at least two bands — over nine metres. Under a metre is the
// residue of the handful of orientation cycles the settling pass cannot resolve, which is
// sub-pixel at any zoom short of standing on the platform.
if (worstSeam > 1) fail("ordered", `a stroke steps ${worstSeam.toFixed(1)} m at a seam — a stretch is drawn on the wrong side`);

// ---- proportioned, and one line when far away -----------------------------
for (let z = 14.5; z <= 18; z += 0.25) {
  const geo = TRACK_M / metresPerPixel(z), f = fanAt(z);
  if (Math.abs(geo + f.colour - 11) > 0.1) fail("proportioned", `colours ${(geo + f.colour).toFixed(1)} px apart at zoom ${z}`);
  if (Math.abs(geo + f.service - 11) > 0.1) fail("proportioned", `same colour ${(geo + f.service).toFixed(1)} px apart at zoom ${z}`);
}
if (fanAt(12).service !== 0) fail("one line far away", "services sharing a colour do not merge at city zoom");
if (fanAt(12).colour < 9) fail("one line far away", "different colours are not far enough apart at city zoom");
let prev = fanAt(9), jump = 0;
for (let z = 9; z <= 21; z += 0.05) {
  const v = fanAt(z);
  jump = Math.max(jump, Math.abs(v.colour - prev.colour), Math.abs(v.service - prev.service));
  prev = v;
}
if (jump > 1.2) fail("proportioned", `the fan moves ${jump.toFixed(2)} px within a twentieth of a zoom level`);

// ---- trains on their own track -------------------------------------------
const NOW = 1_788_000_000;
const kin = new Kinematics(idx);
let checked = 0, worstOff = 0;
for (const s of strokes.slice(0, 120)) {
  for (let i = 0; i + 1 < s.stops.length && checked < 400; i++) {
    const [a, b] = [s.stops[i], s.stops[i + 1]];
    const drawn = idx.lineSegment(s.route, a, b);
    if (!drawn) continue;
    const ridden = idx.pathBetween(s.route, `${a}N`, `${b}N`).pts;
    if (ridden.length !== drawn.length) continue;
    for (let k = 0; k < drawn.length; k++) worstOff = Math.max(worstOff, distM(drawn[k], ridden[k]));
    checked++;
  }
}
if (worstOff > 0.01) fail("trains on their track", `a moving train is drawn ${worstOff.toFixed(2)} m off its own line`);

const offCentre = (() => {
  for (const [key, slots] of Object.entries(net.segmentSlots)) {
    for (const [route, [band]] of Object.entries(slots)) {
      if (Math.abs(band) < 0.5) continue;
      const station = key.split("-")[0];
      if (idx.platformPoint(route, station)) return { route, station };
    }
  }
  return null;
})();
if (!offCentre) fail("trains on their track", "no off-centre platform to test against");
else {
  const st = {
    id: "audit", route: offCentre.route, direction: "N", assigned: true, phase: "dwelling",
    prevStop: offCentre.station, nextStop: offCentre.station, eta: NOW, etaRaw: NOW, sigma: 0,
    updatedAt: NOW, stops: [] as StopPrediction[],
  } as unknown as TrainState;
  const [p] = kin.step([st], NOW, 1);
  const off = distM([p.lon, p.lat], idx.platformPoint(offCentre.route, offCentre.station)!);
  if (off > 0.01) fail("trains on their track", `a standing train is ${off.toFixed(2)} m off its own line`);
}

// ---- orientation ----------------------------------------------------------
const dirs = Object.values(net.segDir ?? {});
if (dirs.length !== Object.keys(net.segments).length) fail("ordered", "not every stretch has an orientation");
notes.push(`${dirs.filter((d) => d < 0).length} of ${dirs.length} stretches run against their key order`);

// ---- report ---------------------------------------------------------------
console.log("line engine\n");
for (const n of notes) console.log(`  ${n}`);
if (!findings.length) {
  console.log("\nPASS — every clause of the contract holds\n");
  process.exit(0);
}
console.log(`\n=== BROKEN CLAUSES (${findings.length}) ===`);
for (const f of findings) console.log(` [${f.clause}] ${f.detail}`);
process.exit(1);
