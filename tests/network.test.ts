/**
 * Layout tests. Each pins a defect the corridor rewrite fixed, because every one of them was
 * invisible in code review and obvious on the map.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NetworkIndex, fanAt, bandOffsetExpression, TRACK_M, metresPerPixel } from "../src/lib/network";
import { distM } from "../src/lib/geo";
import type { LonLat, Network } from "../src/lib/types";

const net = JSON.parse(readFileSync(join(process.cwd(), "public/data/network.json"), "utf8")) as Network;
const idx = new NetworkIndex(net);

/** Every drawn stretch of every service, as the map would draw it. */
function stroke(route: string, stops: string[]): LonLat[] {
  const out: LonLat[] = [];
  for (let i = 0; i + 1 < stops.length; i++) {
    const piece = idx.lineSegment(route, stops[i], stops[i + 1]);
    if (!piece) continue;
    for (const p of piece) {
      const last = out[out.length - 1];
      if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
    }
  }
  return out;
}

test("a train rides exactly on its own line", () => {
  // The whole point of laying lines and trains out through one function. Before it, a train sat
  // 6 m off its line normally and 9 m off once the view was narrowed to a few services.
  let checked = 0, worst = 0;
  for (const [route, runs] of Object.entries(net.routeRuns)) {
    for (const run of runs.slice(0, 3)) {
      for (let i = 0; i + 1 < run.stops.length && checked < 400; i++) {
        const a = run.stops[i], b = run.stops[i + 1];
        const drawn = idx.lineSegment(route, a, b);
        if (!drawn) continue;
        const ridden = idx.pathBetween(route, `${a}N`, `${b}N`).pts;
        if (ridden.length !== drawn.length) continue;
        for (let k = 0; k < drawn.length; k++) worst = Math.max(worst, distM(drawn[k], ridden[k]));
        checked++;
      }
    }
  }
  assert.ok(checked > 100, `expected plenty of segments to compare, got ${checked}`);
  assert.ok(worst < 0.01, `a train drifted ${worst.toFixed(2)} m off its own line`);
});

/**
 * Where two services sit relative to one another, on screen, in pixels — the whole model.
 *
 * `dcb` is their difference in colour index and `dmb` their difference in metric band. The tests
 * below ask about this rather than about the two curves separately, because the curves are an
 * implementation detail and the distance between two lines is the thing anyone can see.
 */
const apart = (z: number, dcb: number, dmb: number) => {
  const f = fanAt(z);
  return dcb * f.colour + dmb * (f.metric + TRACK_M / metresPerPixel(z));
};

test("adjacent lines are eleven pixels apart at every zoom that matters", () => {
  // The contract. The fan supplies whatever the eye needs *minus* what the true 4.6 m already
  // provides, so the total on screen is constant.
  //
  // This used to be asserted of the two curves one at a time, which is not the same thing, and is
  // why it passed while the map was visibly wrong: the geometry was offset by the metric band and
  // the fan by a colour/service split, so the sum of two individually-correct curves put the five
  // services sharing Queens Boulevard at uneven, zoom-dependent spacing. Asking about the
  // distance between two services leaves the two halves nothing to disagree about.
  for (let z = 14.5; z <= 18; z += 0.25) {
    assert.ok(Math.abs(apart(z, 0, 1) - 11) < 0.1, `same colour ${apart(z, 0, 1).toFixed(1)} px apart at zoom ${z}`);
    assert.ok(Math.abs(apart(z, 1, 1) - 11) < 0.1, `next colour ${apart(z, 1, 1).toFixed(1)} px apart at zoom ${z}`);
    assert.ok(Math.abs(apart(z, 0, 2) - 22) < 0.2, `two bands apart ${apart(z, 0, 2).toFixed(1)} px at zoom ${z}`);
  }
});

test("nothing snaps as you zoom", () => {
  // The original defect: the fan was baked into geometry and could only change in steps, so the
  // map visibly snapped every time the zoom crossed one.
  //
  // What is measured is the bend in the curve, not its slope. Two lines genuinely do draw further
  // apart as you zoom past street level — that is the real 4.6 m becoming worth more pixels, and
  // by zoom 21 it is 10 px per twentieth of a level — so a bound on the slope would either fail
  // on correct behaviour or be too loose to catch anything. A step shows up as a spike in the
  // second difference whatever the slope around it does; smooth growth does not.
  let worst = 0;
  for (let z = 9.1; z <= 21; z += 0.05) {
    for (const [dcb, dmb] of [[0, 1], [1, 1], [1, 2], [2, 3], [2, 4]] as [number, number][]) {
      const bend = apart(z, dcb, dmb) - 2 * apart(z - 0.05, dcb, dmb) + apart(z - 0.1, dcb, dmb);
      worst = Math.max(worst, Math.abs(bend) / Math.max(Math.abs(dcb), Math.abs(dmb)));
    }
  }
  // The deliberate reveal between zoom 13.4 and 14.2 bends by 0.50; a step would be several px,
  // and a band landing in the wrong place would be eleven.
  assert.ok(worst < 1.5, `the curve bent ${worst.toFixed(2)} px per band within a twentieth of a zoom level`);
});

test("past street level the lines stand on the real track spacing", () => {
  // Close enough in, 4.6 m is worth more than the target on its own and the fan gets out of the
  // way: what you see is where the track is.
  assert.equal(fanAt(19).colour, 0, "the colour reading has finished merging into the metric one");
  assert.equal(fanAt(19).metric, 0, "and the metric reading is the geometry's own");
  const geo = TRACK_M / metresPerPixel(19);
  assert.ok(Math.abs(apart(19, 1, 1) - geo) < 1e-9, "two adjacent services sit one real track apart");
});

test("services sharing a trunk colour merge as the map zooms out", () => {
  // The 4, 5 and 6 are one green Lexington line on any map of this system until you are close
  // enough to care which is which. Colours are lines in their own right and never merge.
  assert.ok(apart(12, 0, 1) < 0.5, "same-colour services sit on one another at city zoom");
  assert.ok(apart(12, 1, 1) > 9, "different colours stay apart there");
  assert.ok(apart(16, 0, 1) > 7, "and part once you are close enough to tell them apart");
});

test("lines and trains are placed by the same fan", () => {
  // The renderer follows the expression; the trains follow the function. If they ever disagreed,
  // a train would sit beside its line rather than on it.
  const expr = bandOffsetExpression(1);
  // MapLibre drops a layer whose zoom interpolation is not the outermost expression, which took
  // most of the network off the map once. The shape is load-bearing, so it is asserted.
  assert.equal(expr[0], "interpolate");
  assert.deepEqual(expr[2], ["zoom"], "the zoom interpolation has to be outermost");
  for (let i = 3; i + 1 < expr.length; i += 2) {
    const zoom = expr[i] as number;
    const [, colourTerm, metricTerm] = expr[i + 1] as unknown[];
    assert.deepEqual((colourTerm as unknown[])[1], ["get", "cb"]);
    assert.deepEqual((metricTerm as unknown[])[1], ["get", "mb"]);
    const at = fanAt(zoom);
    assert.ok(Math.abs(((colourTerm as unknown[])[2] as number) - at.colour) < 1e-9, `colour disagrees at zoom ${zoom}`);
    assert.ok(Math.abs(((metricTerm as unknown[])[2] as number) - at.metric) < 1e-9, `metric disagrees at zoom ${zoom}`);
  }
});

test("a change of band is a splay, not a step", () => {
  // Strokes are cut where a service changes band; the two pieces have to meet at the station.
  let pairs = 0, worst = 0;
  for (const [route, runs] of Object.entries(net.routeRuns)) {
    const drawn = runs.map((r) => ({ run: r, geom: stroke(route, r.stops) })).filter((x) => x.geom.length > 1);
    for (const from of drawn) {
      const at = from.run.stops[from.run.stops.length - 1];
      for (const to of drawn) {
        if (to === from || to.run.stops[0] !== at) continue;
        pairs++;
        worst = Math.max(worst, distM(from.geom[from.geom.length - 1], to.geom[0]));
      }
    }
  }
  assert.ok(pairs > 20, `expected band changes to compare, got ${pairs}`);
  // A band is 8 m; anything approaching that is a step rather than a splay.
  assert.ok(worst <= 8.01, `strokes parted by ${worst.toFixed(1)} m at a band change`);
});

test("bands do not mirror where a segment key runs against its corridor", () => {
  // Segment keys are ordered by station id, which is not geography. Where that ordering reverses,
  // the same band used to land on the opposite side of the track — 22% of segments were affected.
  const dirs = Object.values(net.segDir ?? {});
  assert.ok(dirs.length === Object.keys(net.segments).length, "every segment needs an orientation");
  assert.ok(dirs.some((d) => d < 0), "some segments really do run against their key order");
  assert.ok(dirs.every((d) => d === 1 || d === -1), "an orientation is a direction, not a scale");
});

test("every service in a corridor gets its own band, and no two share one", () => {
  let shared = 0;
  for (const [key, slots] of Object.entries(net.segmentSlots)) {
    const bands = Object.entries(slots);
    if (bands.length < 2) continue;
    shared++;
    const seen = new Map<number, string>();
    for (const [route, [band]] of bands) {
      const other = seen.get(band);
      assert.equal(other, undefined, `${route} and ${other} share band ${band} on ${key}`);
      seen.set(band, route);
    }
  }
  assert.ok(shared > 200, `expected many shared corridors, got ${shared}`);
});

test("the weave has a consistent over-and-under", () => {
  // Bands further right always pass over bands further left, so a pair never weaves one way in
  // one place and the other way somewhere else.
  for (const runs of Object.values(net.routeRuns)) {
    for (const run of runs) {
      assert.ok(Number.isInteger(run.z) && run.z >= 0 && run.z <= 4, `bad weave level ${run.z}`);
      const expected = Math.max(0, Math.min(4, Math.round(run.slot + 2)));
      assert.equal(run.z, expected, "draw order must follow the band, or crossings disagree");
    }
  }
});
