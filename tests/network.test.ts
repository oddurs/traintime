/**
 * Layout tests. Each pins a defect the corridor rewrite fixed, because every one of them was
 * invisible in code review and obvious on the map.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NetworkIndex, fanAt, bandOffsetExpression } from "../src/lib/network";
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

test("the fan eases across zoom instead of stepping", () => {
  // The fan used to be baked into the geometry, so it could only change in steps and the map
  // visibly jumped every time the zoom crossed one. It is a paint property now, and has to be
  // continuous for the renderer to ease it.
  let prev = fanAt(9), worst = 0;
  for (let z = 9; z <= 21; z += 0.05) {
    const v = fanAt(z);
    worst = Math.max(worst, Math.abs(v.colour - prev.colour), Math.abs(v.service - prev.service));
    prev = v;
  }
  assert.ok(worst < 0.35, `the fan jumped ${worst.toFixed(2)} px within a twentieth of a zoom level`);
});

test("services sharing a trunk colour merge as the map zooms out", () => {
  // The 4, 5 and 6 are one green Lexington line on any map of this system until you are close
  // enough to care which is which. Colours are lines in their own right and never merge.
  assert.equal(fanAt(12).service, 0, "same-colour services sit on one another at city zoom");
  assert.ok(fanAt(12).colour > 9, "different colours stay apart there");
  assert.ok(fanAt(16).service > 7, "and part once you are close enough to tell them apart");
  const far = fanAt(19.5);
  assert.equal(far.colour, 0, "zoomed right in, the true track spacing does the whole job");
  assert.equal(far.service, 0);
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
    const [, colourTerm, serviceTerm] = expr[i + 1] as unknown[];
    assert.deepEqual((colourTerm as unknown[])[1], ["get", "cb"]);
    assert.deepEqual((serviceTerm as unknown[])[1], ["get", "sb"]);
    const at = fanAt(zoom);
    assert.ok(Math.abs(((colourTerm as unknown[])[2] as number) - at.colour) < 1e-9, `colour disagrees at zoom ${zoom}`);
    assert.ok(Math.abs(((serviceTerm as unknown[])[2] as number) - at.service) < 1e-9, `service disagrees at zoom ${zoom}`);
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
