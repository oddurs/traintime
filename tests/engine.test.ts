/**
 * The modules that decide the most and were tested the least: the model evaluator, the motion
 * engine, and the board builder. All three were previously exercised only through a 25-minute
 * replay, which meant a defect in any of them was expensive to find and easy to miss.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NetworkIndex } from "../src/lib/network";
import { Kinematics } from "../src/lib/kinematics";
import { gbmPredict } from "../src/lib/gbm";
import { distM } from "../src/lib/geo";
import { add as addToHistogram, merge as mergeInto, quantile as quantileOf, stat as statFrom, total as totalOf, BUCKET_S, type Histogram } from "../src/lib/histogram";
import { arrivalsAt } from "../src/lib/arrivals";
import type { GbmModel, Network, StopPrediction, TrainState } from "../src/lib/types";

const root = process.cwd();
const net = JSON.parse(readFileSync(join(root, "public/data/network.json"), "utf8")) as Network;
const idx = new NetworkIndex(net);
const NOW = 1_788_000_000;

// ---------- the model evaluator ----------

test("the model gives the same answer in TypeScript as it does in Python", () => {
  // sklearn trains it, the trainer's own walk of the exported trees produced these answers, and
  // this evaluator has to reproduce them. Nothing else in the system would notice if it did not:
  // every prediction would simply be quietly wrong.
  //
  // The sample rides inside the model because the model retrains itself nightly; a fixture beside
  // it went stale the first time that happened.
  const model = JSON.parse(readFileSync(join(root, "public/data/eta-model.json"), "utf8")) as GbmModel;
  assert.ok(model.parity?.length, "the model must carry its own parity sample");
  let worst = 0;
  for (const c of model.parity!) {
    const x = c.x.map((v) => (v === null ? NaN : v));
    worst = Math.max(worst, Math.abs(gbmPredict(model, x) - c.y));
  }
  assert.ok(worst < 1e-6, `the two implementations differ by up to ${worst}`);
});

// ---------- the motion engine ----------

/** A train running between two stations the 1 actually serves. */
const runStops = net.shapeStops[Object.keys(net.shapeStops).find((k) => k.startsWith("1.."))!];
const moving = (over: Partial<TrainState> = {}): TrainState => ({
  id: "T", route: "1", direction: "S", assigned: true, phase: "moving",
  prevStop: runStops[3], nextStop: runStops[4],
  eta: NOW + 90, etaRaw: NOW + 90, sigma: 20, departedAt: NOW, runTime: 90,
  updatedAt: NOW, stops: [] as StopPrediction[], ...over,
} as unknown as TrainState);

test("a train never moves backwards, however the clock jumps", () => {
  const kin = new Kinematics(idx);
  const st = moving();
  let last = -1;
  for (let t = NOW; t < NOW + 200; t += 1) {
    const [p] = kin.step([st], t, 1);
    assert.ok(p.s >= last - 1e-6, `went backwards at t+${t - NOW}: ${p.s} after ${last}`);
    last = p.s;
  }
});

/**
 * The longest stretch any service runs without stopping, so the engine is asked to go as fast as
 * it ever will. Asserting on a short hop is how a motion test passes with the physics removed:
 * the pacing controller keeps the speed low for its own reasons and the braking curve is never
 * the thing under test.
 */
const longestRun = (() => {
  // Long enough to reach line speed, short enough to arrive inside the test's run: the Staten
  // Island line has a 13 km hop, on which a train never gets near a platform in any reasonable
  // number of steps and the braking curve is never the thing under test.
  let best = { route: "", a: "", b: "", len: 0 };
  for (const [route, runs] of Object.entries(net.routeRuns)) {
    for (const run of runs) {
      for (let i = 0; i + 1 < run.stops.length; i++) {
        const p = idx.pathBetween(route, `${run.stops[i]}N`, `${run.stops[i + 1]}N`);
        if (p.length > best.len && p.length < 3000) best = { route, a: `${run.stops[i]}N`, b: `${run.stops[i + 1]}N`, len: p.length };
      }
    }
  }
  return best;
})();

/** Step until the train berths, so the whole trajectory including the stop is under test. */
function runToPlatform(st: TrainState, each: (p: { s: number; length: number; speed: number }) => void) {
  const kin = new Kinematics(idx);
  for (let t = NOW; t < NOW + 900; t += 1) {
    const [p] = kin.step([st], t, 1);
    each(p);
    if (p.length - p.s < 1) return true;
  }
  return false;
}

/** Paced to arrive far sooner than it possibly can, so the engine's own limits are what bind. */
const flatOut = (): TrainState => ({
  id: "F", route: longestRun.route, direction: "N", assigned: true, phase: "moving",
  prevStop: longestRun.a, nextStop: longestRun.b,
  eta: NOW + 5, etaRaw: NOW + 5, sigma: 20, departedAt: NOW, runTime: 5,
  updatedAt: NOW, stops: [] as StopPrediction[],
} as unknown as TrainState);

test("it never draws a train faster than a subway train goes", () => {
  assert.ok(longestRun.len > 1500, `expected a long run to test on, got ${longestRun.len.toFixed(0)} m`);
  let fastest = 0;
  const arrived = runToPlatform(flatOut(), (p) => { fastest = Math.max(fastest, p.speed); });
  assert.ok(arrived, "the train should reach the platform within the test's run");
  assert.ok(fastest > 15, "on a run this long it should actually get going");
  // 27 m/s is about 97 km/h; the R211 tops out around 88.
  assert.ok(fastest <= 27.5, `drew ${fastest.toFixed(1)} m/s, which is not a subway train`);
});

test("it stays on a braking curve it can actually stop from", () => {
  // The invariant the braking curve exists to provide: at any point, the speed must be one the
  // train could still shed before the platform. Remove the curve and this fails immediately.
  let worst = 0;
  const arrived = runToPlatform(flatOut(), (p) => {
    const stoppable = Math.sqrt(2 * 1.2 * Math.max(0, p.length - p.s));
    worst = Math.max(worst, p.speed - stoppable);
  });
  assert.ok(arrived, "the train should reach the platform within the test's run");
  // No slack. Braking against the distance at the start of a step starts the brake one step
  // late and the train cannot make it back, which is how it used to arrive at 8.8 m/s and be
  // snapped to a stand. The controller looks a step ahead, so the invariant holds exactly.
  assert.ok(worst <= 0.01, `carried ${worst.toFixed(2)} m/s more than it could stop from`);
});

test("no step accelerates or brakes harder than a train can", () => {
  // Without this the engine could satisfy every other invariant by jumping to whatever speed it
  // wants each step: never too fast, always on the braking curve, and physically nonsense.
  // Measured while it is still running. The last step is the train berthing, which compresses
  // whatever is left into the metre or so before the platform — 1.6 m/s over 1.5 m is 0.8 m/s²,
  // well inside what a train does; the step simply ends early.
  let worst = 0, prev = 0;
  runToPlatform(flatOut(), (p) => {
    if (p.length - p.s > 1) worst = Math.max(worst, Math.abs(p.speed - prev));
    prev = p.speed;
  });
  assert.ok(worst <= 1.25, `changed speed by ${worst.toFixed(2)} m/s in one second`);
});

test("a measured approach carries a train further along than none", () => {
  // The contract of the one position the feed gives us between platforms: a train told it has
  // begun its final approach should be further down the track than one that was not.
  //
  // Asserting only that it never goes backwards would pass whatever the sign, because the
  // correction is bounded by the line speed and so can never overcome the train's own motion.
  // That bound is a good property; it just means "not backwards" tests nothing.
  const base = { ...flatOut(), eta: NOW + 600, etaRaw: NOW + 600, runTime: 600 } as TrainState;
  const told = { ...base, id: "told", approach: { since: NOW, typical: 13 } } as TrainState;
  const run = (st: TrainState) => {
    const kin = new Kinematics(idx);
    let s = 0, last = -1, back = 0;
    for (let t = NOW; t < NOW + 60; t += 1) {
      const [p] = kin.step([st], t, 1);
      if (p.s < last - 1e-6) back++;
      last = p.s; s = p.s;
    }
    return { s, back };
  };
  const plain = run(base), fixed = run(told);
  assert.equal(plain.back, 0, "a train never moves backwards");
  assert.equal(fixed.back, 0, "and the approach fix must not make it");
  assert.ok(fixed.s > plain.s + 1, `the approach should carry it further: ${fixed.s.toFixed(0)} m against ${plain.s.toFixed(0)} m`);
});

test("a train standing at a platform is on its own line, not the middle of the corridor", () => {
  // A station's coordinate is the centre of the corridor; a service is drawn in its own band
  // beside it. Placing a standing train at the station put it a median 2.3 m — and up to 9.2 m,
  // which is two bands — off the track it belongs to, plainly visible once you zoom in.
  //
  // It has to be tested somewhere the service is actually off-centre. On a stretch it has to
  // itself the band is zero, the two points coincide, and the test would pass either way.
  const offCentre = (() => {
    for (const [key, slots] of Object.entries(net.segmentSlots)) {
      for (const [route, [band]] of Object.entries(slots)) {
        if (Math.abs(band) < 0.5) continue;
        const station = key.split("-")[0];
        if (idx.platformPoint(route, station)) return { route, station, band };
      }
    }
    return null;
  })();
  assert.ok(offCentre, "expected some service to run off the centre of a shared corridor");
  const { route, station } = offCentre!;

  const dwelling = {
    id: "D", route, direction: "N", assigned: true, phase: "dwelling",
    prevStop: station, nextStop: station, eta: NOW, etaRaw: NOW, sigma: 0,
    updatedAt: NOW, stops: [] as StopPrediction[],
  } as unknown as TrainState;
  const [p] = new Kinematics(idx).step([dwelling], NOW, 1);
  const onLine = idx.platformPoint(route, station)!;
  const centre = idx.station(station)!;
  assert.ok(distM(onLine, [centre.lon, centre.lat]) > 1, "this platform should be off the corridor centre");
  assert.ok(distM([p.lon, p.lat], onLine) < 0.01, `stood ${distM([p.lon, p.lat], onLine).toFixed(2)} m off its own line`);
});

// ---------- the board ----------

const stopsFrom = (ids: string[], start: number, gap = 120): StopPrediction[] =>
  ids.map((id, i) => ({ id, eta: start + i * gap, etaRaw: start + i * gap, sigma: 15 }));

test("a board lists the whole complex, soonest first", () => {
  const station = runStops[6].replace(/[NS]$/, "");
  const a = moving({ id: "a", nextStop: runStops[6], eta: NOW + 300, stops: stopsFrom(runStops.slice(6, 10), NOW + 300) });
  const b = moving({ id: "b", nextStop: runStops[6], eta: NOW + 120, stops: stopsFrom(runStops.slice(6, 10), NOW + 120) });
  const groups = arrivalsAt(idx, [a, b], station);
  const all = groups.flatMap((g) => g.arrivals);
  assert.equal(all.length, 2);
  assert.equal(all[0].id, "b", "the next train comes first");
});

test("a board never offers a train that has not started or has gone stale", () => {
  const station = runStops[6].replace(/[NS]$/, "");
  const dead = moving({ id: "ghost", stale: true, stops: stopsFrom(runStops.slice(6, 10), NOW + 120) } as Partial<TrainState>);
  const notStarted = moving({ id: "unstarted", phase: "unstarted", stops: stopsFrom(runStops.slice(6, 10), NOW + 120) } as Partial<TrainState>);
  assert.equal(arrivalsAt(idx, [dead, notStarted], station).flatMap((g) => g.arrivals).length, 0);
});

test("asking for a destination drops trains that never reach it, and times the ride", () => {
  const station = runStops[6].replace(/[NS]$/, "");
  const to = runStops[9].replace(/[NS]$/, "");
  const goes = moving({ id: "goes", nextStop: runStops[6], eta: NOW + 120, stops: stopsFrom(runStops.slice(6, 10), NOW + 120) });
  const stopsShort = moving({ id: "short", nextStop: runStops[6], eta: NOW + 60, stops: stopsFrom(runStops.slice(6, 8), NOW + 60) });
  const all = arrivalsAt(idx, [goes, stopsShort], station, 6, to).flatMap((g) => g.arrivals);
  assert.equal(all.length, 1, "only the train that gets there should be offered");
  assert.equal(all[0].id, "goes");
  assert.ok(all[0].rideSeconds! > 0, "and it should say how long the ride is");
});

// ---------- sufficient statistics ----------

test("a histogram answers the same questions as the rows it replaces", () => {
  // The whole argument for keeping counts instead of observations: a table built from summaries
  // has to match one built from rows, or a year of history is worth less than a week of it.
  const rows: number[] = [];
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < 20_000; i++) {
    // Skewed and heavy-tailed, like a real residual: mostly early, occasionally very late.
    rows.push(Math.round(-30 + 40 * (rnd() - 0.5) + (rnd() < 0.05 ? 300 * rnd() : 0)));
  }
  const h: Histogram = new Map();
  for (const r of rows) addToHistogram(h, r);

  const exact = [...rows].sort((a, b) => a - b);
  const q = (p: number) => exact[Math.floor(exact.length * p)];
  assert.equal(totalOf(h), rows.length, "no observation may be lost");
  for (const p of [0.16, 0.5, 0.84]) {
    const off = Math.abs(quantileOf(h, p) - q(p));
    assert.ok(off <= BUCKET_S, `quantile ${p} differs by ${off} s, more than a bucket`);
  }
  const median = q(0.5);
  const exactSpread = [...rows].map((x) => Math.abs(x - median)).sort((a, b) => a - b);
  const s = statFrom(h);
  assert.ok(Math.abs(s.median - median) <= BUCKET_S);
  assert.ok(Math.abs(s.p68 - exactSpread[Math.floor(exactSpread.length * 0.68)]) <= BUCKET_S * 2);
});

test("histograms merge by addition, so old summaries count as much as new rows", () => {
  const a: Histogram = new Map(), b: Histogram = new Map(), both: Histogram = new Map();
  for (let i = 0; i < 500; i++) { addToHistogram(a, i % 97); addToHistogram(both, i % 97); }
  for (let i = 0; i < 300; i++) { addToHistogram(b, 50 + (i % 31)); addToHistogram(both, 50 + (i % 31)); }
  mergeInto(a, b);
  assert.equal(totalOf(a), 800);
  assert.equal(quantileOf(a, 0.5), quantileOf(both, 0.5), "merging must equal counting together");
});
