/**
 * Layout tests. Each pins a defect the corridor rewrite fixed, because every one of them was
 * invisible in code review and obvious on the map.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NetworkIndex, fanAt, lineWidthAt, casingWidthAt, DRAWN_AS, TRACK_M, metresPerPixel } from "../src/lib/network";
import { buildLineMesh, parseColour, LINE_STRIDE } from "../src/lib/lineGeometry";
import { distM } from "../src/lib/geo";
import { TRUNKS, serviceColours } from "../src/lib/trunks";
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
  /*
   * There is one fan now. `lineLayer.ts` and `trainLayer.ts` both call `fanAt` in their vertex
   * stage, from the camera of the frame being drawn, so the two cannot disagree about the curve —
   * which is what the expression this test used to inspect could not promise. What is left to
   * check is that the geometry handed to the shader carries the band the stroke actually rides,
   * because that is the one place the two could still be fed different numbers.
   */
  const mesh = buildLineMesh(idx);
  const strokes = idx.strokes().filter((st) => st.pts.length >= 2).sort((x, y) => x.z - y.z);

  let v = 0;
  for (const st of strokes) {
    // A cap pair at each end, and a pair per point, all carrying the stroke's own band.
    const pairs = st.pts.length + 2;
    for (let k = 0; k < pairs * 2; k++) {
      const o = (v + k) * LINE_STRIDE;
      // fround, because the buffer holds single precision and the stroke holds double — an
      // epsilon here would hide a band being off by a hair, which is exactly what this guards.
      assert.equal(mesh.vertices[o + 8], Math.fround(st.cb), `vertex ${v + k} rides colour band ${mesh.vertices[o + 8]}, not ${st.cb}`);
      assert.equal(mesh.vertices[o + 9], Math.fround(st.mb), `vertex ${v + k} rides metric band ${mesh.vertices[o + 9]}, not ${st.mb}`);
    }
    v += pairs * 2;
  }
  assert.equal(v, mesh.vertexCount, "every vertex belongs to a stroke");

  // Sides alternate, so the strip has two edges and not one.
  for (let k = 0; k < mesh.vertexCount; k++) {
    assert.equal(mesh.vertices[k * LINE_STRIDE + 6], k % 2 === 0 ? -1 : 1);
  }
});

test("the weave is drawn lowest level first, and every triangle belongs to one", () => {
  // The interleaving is what makes a crossing read as one line passing under another. It only
  // works if each level's triangles are contiguous and the ranges cover the buffer exactly.
  const mesh = buildLineMesh(idx);
  let covered = 0, last = -1;
  mesh.levels.forEach((lv, z) => {
    if (lv.count === 0) return;
    assert.ok(lv.start >= last, `level ${z} starts before the level beneath it ends`);
    last = lv.start + lv.count;
    covered += lv.count;
  });
  assert.equal(covered, mesh.indices.length, "every triangle sits in exactly one level");
  for (const ix of mesh.indices) assert.ok(ix < mesh.vertexCount, "an index points past the buffer");
});

test("the drawn widths are the ones the style used to carry", () => {
  // The custom layer replaced two three-stop ramps with two functions. Same numbers, or the map
  // quietly changes weight.
  for (const [z, line, casing] of [[10, 1.1, 2.3], [13, 2.3, 3.9], [16, 4.2, 6.6], [17, 4.2, 6.6]] as const) {
    assert.ok(Math.abs(lineWidthAt(z) - line) < 1e-9, `line width at ${z}`);
    assert.ok(Math.abs(casingWidthAt(z) - casing) < 1e-9, `casing width at ${z}`);
  }
  // And between stops it is the same straight line the expression drew.
  assert.ok(Math.abs(lineWidthAt(11.5) - 1.7) < 1e-9);
  assert.ok(Math.abs(casingWidthAt(14.5) - 5.25) < 1e-9);
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

test("a train is never drawn on track that does not exist", () => {
  // The feed reports trips whose intermediate stops have been dropped, and then "the stop before"
  // and "the stop next" are twenty stations apart. Joining them with a straight line drew a B from
  // 81 St to DeKalb Av: ten kilometres across Manhattan, through Central Park, with a marker
  // sliding along it. There is no track between them, so there is no line to draw.
  // Both taken from a live feed: a B whose next stop is twenty stations away, and a D said to be
  // running *south* from Grand St to 145 St, which is north of it. Neither can be walked through
  // the route graph, because neither is a journey the railway makes.
  const far: [string, string, string][] = [
    ["B", "A21N", "R30N"],   // 81 St-Museum of Natural History -> DeKalb Av
    ["D", "D22S", "D13S"],   // Grand St -> 145 St, southbound, in that order
  ];
  /** Where this service's track actually is, coarsely bucketed so the test is not quadratic. */
  const CELL = 80;
  const track = (route: string) => {
    const grid = new Set<string>();
    for (const key of net.routeSegments[route] ?? []) {
      for (const p of net.segments[key] ?? []) {
        const cos = Math.cos((p[1] * Math.PI) / 180);
        const x = Math.round((p[0] * 111_320 * cos) / CELL), y = Math.round((p[1] * 111_320) / CELL);
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) grid.add(`${x + dx}:${y + dy}`);
      }
    }
    return grid;
  };
  for (const [route, from, to] of far) {
    const path = idx.pathBetween(route, from, to);
    const grid = track(route);
    // Sampled along the line, not just at its ends. Checking only the vertices passes a straight
    // line drawn between two real stations twenty stops apart — both ends are on track and the ten
    // kilometres in between are not, which is the whole of the defect.
    let off = 0, samples = 0;
    for (let i = 0; i + 1 < path.pts.length; i++) {
      const a = path.pts[i], b = path.pts[i + 1];
      const steps = Math.max(1, Math.ceil(distM(a, b) / 100));
      for (let k = 0; k <= steps; k++) {
        const t = k / steps;
        const p: LonLat = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        const cos = Math.cos((p[1] * Math.PI) / 180);
        samples++;
        if (!grid.has(`${Math.round((p[0] * 111_320 * cos) / CELL)}:${Math.round((p[1] * 111_320) / CELL)}`)) off++;
      }
    }
    assert.ok(samples > 2, `${route} ${from}->${to} produced no path to check`);
    assert.equal(off, 0, `${route} ${from}->${to} is drawn ${off} of ${samples} samples away from its own track`);
  }
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

test("every service belongs to exactly one trunk line, and takes its colour from it", () => {
  // The network is organised by trunk, not by service, so a colour is a statement about the
  // network and has to come from the table that describes one. The feed's own colours disagree:
  // it hands the L and all three shuttles a single grey, which made the 42 St shuttle merge into
  // the L when you zoomed out — two services sharing no track, in different boroughs.
  const seen = new Map<string, string>();
  for (const [id, trunk] of Object.entries(TRUNKS)) {
    for (const service of trunk.services) {
      assert.ok(!seen.has(service), `${service} is on both the ${seen.get(service)} and ${id} trunks`);
      seen.set(service, id);
    }
  }
  for (const route of Object.keys(net.routes)) {
    assert.ok(seen.has(route), `${route} runs on no trunk line — add it to src/lib/trunks.ts`);
    const { color, textColor } = serviceColours(route);
    assert.equal(net.routes[route].color, color, `${route} is not drawn in its trunk's colour`);
    assert.equal(net.routes[route].textColor, textColor, `${route}'s character is not set in its trunk's ink`);
  }
  // And the trunks are actually distinguishable from one another.
  const colours = new Set(Object.values(TRUNKS).map((t) => t.token));
  assert.equal(colours.size, Object.keys(TRUNKS).length, "two trunk lines share a colour");
});

test("a train running off its timetable still rides a real line", () => {
  // The feed runs services off their own schedule — a C extended past 168 St onto the A's track,
  // an R terminating at Forest Hills on the E and F's. The track is there and the train is really
  // on it; what is missing is a band, because the ordering was built from a timetable that does
  // not know about the trip. That put about one moving train in twenty on the centreline of its
  // corridor, running between the lines rather than on one.
  let checked = 0;
  for (const [key, slots] of Object.entries(net.segmentSlots)) {
    const carries = Object.keys(slots);
    if (carries.length < 2) continue;
    const [u, v] = key.split("-");
    for (const route of Object.keys(net.routes)) {
      if (slots[route]) continue;
      const band = idx.lateralBand(route, `${u}N`, `${v}N`);
      assert.ok(band, `${route} gets no band at all on ${key}`);
      // Whatever it borrowed has to be a band one of this stretch's own services actually uses.
      const side = (net.segDir?.[key] ?? 1);
      const matches = carries.some((r) =>
        net.bandParts[key]![r]![0] * side === band!.cb && net.bandParts[key]![r]![1] * side === band!.mb);
      assert.ok(matches, `${route} on ${key} rides cb ${band!.cb} mb ${band!.mb}, which is no service's band there`);
      checked++;
      if (checked > 4000) return;
    }
  }
  assert.ok(checked > 500, `expected plenty of off-timetable pairs to check, got ${checked}`);
});

test("the weave has a consistent over-and-under", () => {
  // Bands further right always pass over bands further left, so a pair never weaves one way in
  // one place and the other way somewhere else.
  //
  // Nine levels, not five: the widest corridor runs from band -3.5 to 3.5, and with five the
  // outermost pair on each side was clamped onto its neighbour's level, where a crossing between
  // them cannot show at all.
  const LEVELS = 9;
  const zOf = (slot: number) => Math.max(0, Math.min(LEVELS - 1, Math.round(slot + (LEVELS - 1) / 2)));
  let widest = 0;
  for (const runs of Object.values(net.routeRuns)) {
    for (const run of runs) {
      assert.ok(Number.isInteger(run.z) && run.z >= 0 && run.z < LEVELS, `bad weave level ${run.z}`);
      assert.equal(run.z, zOf(run.slot), "draw order must follow the band, or crossings disagree");
      widest = Math.max(widest, Math.abs(run.slot));
    }
  }
  // And there are enough levels for the bands that actually exist: clamping is the failure mode.
  assert.ok(zOf(widest) > 0 && zOf(-widest) < LEVELS - 1,
    `band ${widest} is clamped onto its neighbour's draw level`);
});

/**
 * Every casing in the network drew magenta at three quarters opacity because `--map-casing` is
 * authored `#000000`, computes to `#000`, and the parser only knew the six-digit form. It did not
 * read as a parse failure — it read as the whole map having gone slightly wrong, which is the kind
 * of bug a screenshot catches and a type checker never will.
 */
test("a colour is read in every form the token layer emits", () => {
  const near = (a: readonly number[], b: readonly number[]) => a.every((x, i) => Math.abs(x - b[i]) < 1e-6);
  assert.ok(near(parseColour("#000"), [0, 0, 0]), "short hex");
  assert.ok(near(parseColour("#000000"), [0, 0, 0]), "long hex");
  assert.ok(near(parseColour("#fff"), [1, 1, 1]));
  assert.ok(near(parseColour("#ee352e"), [238 / 255, 53 / 255, 46 / 255]));
  assert.ok(near(parseColour("rgb(0, 57, 166)"), [0, 57 / 255, 166 / 255]));
  // Alpha is the layer's business, so it is dropped rather than folded into the colour.
  assert.ok(near(parseColour("#ee352e80"), [238 / 255, 53 / 255, 46 / 255]), "hex with alpha");

  // And every colour the network actually carries reads as itself rather than as the fallback.
  const magenta = (p: readonly number[]) => p[0] === 1 && p[1] === 0 && p[2] === 1;
  for (const st of idx.strokes()) {
    assert.ok(!magenta(parseColour(st.colour)), `${st.route} draws in the fallback colour: ${st.colour}`);
  }
});

/**
 * A diamond service is drawn as its parent.
 *
 * `6X`, `7X` and `FX` are in the feed and in the network with their own runs and their own slot, so
 * they were drawn as a second line beside their parent in the *same colour* — a doubled green line
 * beside the green line, which carries no colour information and is most of what a busy corridor
 * looked like. The printed map has always put the express on the bullet instead.
 */
test("the diamond services ride their parent's line rather than a second one", () => {
  const drawn = new Set(idx.strokes().map((s) => s.route));
  for (const x of Object.keys(DRAWN_AS)) {
    assert.ok(!drawn.has(x), `${x} still draws a line of its own`);
    assert.ok(drawn.has(DRAWN_AS[x]), `${DRAWN_AS[x]} should still be drawn for ${x} to ride`);
  }

  // And a diamond train has to be placed on the line that is actually there, or it would sit beside
  // a line nobody drew — which is the whole failure the fan work existed to prevent.
  let checked = 0;
  for (const [x, parent] of Object.entries(DRAWN_AS)) {
    for (const run of (net.routeRuns[x] ?? []).slice(0, 2)) {
      for (let i = 0; i + 1 < run.stops.length && checked < 40; i++) {
        const a = `${run.stops[i]}N`, b = `${run.stops[i + 1]}N`;
        const express = idx.lateralBand(x, a, b, 0.5);
        const local = idx.lateralBand(parent, a, b, 0.5);
        if (!express || !local) continue;
        assert.equal(express.cb, local.cb, `${x} rides a different colour band from ${parent}`);
        assert.equal(express.mb, local.mb, `${x} rides a different metric band from ${parent}`);
        checked++;
      }
    }
  }
  assert.ok(checked > 5, `expected some shared stretches to compare, got ${checked}`);
});
