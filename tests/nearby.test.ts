/**
 * The nearby list: which stations are inside the walking radius, in what order, with which trains.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NetworkIndex } from "../src/lib/network";
import { nearbyStations, radiusMetres, RADII_MIN } from "../src/lib/nearby";
import { walkSeconds } from "../src/lib/places";
import type { Network, TrainState } from "../src/lib/types";

const net = JSON.parse(readFileSync(join(process.cwd(), "public/data/network-lite.json"), "utf8")) as Network;
const idx = new NetworkIndex(net);
/** Times Sq-42 St, on the 1/2/3 platform. */
const TIMES_SQ = net.stations["127"];

function train(id: string, route: string, stops: [string, number][]): TrainState {
  return {
    id, route, direction: "S", assigned: true, phase: "moving", status: "running",
    nextStop: stops[0][0], eta: stops[0][1], etaRaw: stops[0][1], sigma: 20,
    stops: stops.map(([sid, eta]) => ({ id: sid, eta, etaRaw: eta, sigma: 20 })),
  } as unknown as TrainState;
}

test("the radius and the walk time agree", () => {
  // A station on the edge of the ten-minute circle is one the board calls a ten-minute walk.
  for (const m of RADII_MIN) assert.ok(Math.abs(walkSeconds(radiusMetres(m)) - m * 60) < 1e-6);
});

test("only stations inside the radius are listed, closest first, one row per complex", () => {
  const r = radiusMetres(20);
  const out = nearbyStations(idx, [], TIMES_SQ.lat, TIMES_SQ.lon, r, 3, 50);
  assert.ok(out.length > 3, `expected several stations within twenty minutes of Times Sq, got ${out.length}`);
  assert.equal(out[0].name, "Times Sq-42 St");
  for (let i = 1; i < out.length; i++) assert.ok(out[i].meters >= out[i - 1].meters, "not in walking order");
  for (const s of out) assert.ok(s.meters <= r, `${s.name} is ${Math.round(s.meters)} m away, outside ${Math.round(r)} m`);
  // The four Times Sq platforms are one place to walk to.
  assert.equal(out.filter((s) => s.name === "Times Sq-42 St").length, 1);
  assert.equal(new Set(out.map((s) => s.id)).size, out.length);
});

test("the list stops at the station limit", () => {
  const out = nearbyStations(idx, [], TIMES_SQ.lat, TIMES_SQ.lon, radiusMetres(20), 3, 4);
  assert.equal(out.length, 4);
});

test("a station's trains are its soonest, either direction, up to the limit", () => {
  const now = 1_000_000;
  const trains = [
    train("a", "1", [["127S", now + 400]]),
    train("b", "2", [["127S", now + 100]]),
    { ...train("c", "3", [["127N", now + 250]]), direction: "N" } as TrainState,
    train("d", "1", [["127S", now + 900]]),
    // Somewhere else entirely: never listed at Times Sq.
    train("e", "7", [["701S", now + 50]]),
  ];
  const [times] = nearbyStations(idx, trains, TIMES_SQ.lat, TIMES_SQ.lon, radiusMetres(5), 3);
  assert.equal(times.name, "Times Sq-42 St");
  assert.deepEqual(times.arrivals.map((a) => a.id), ["b", "c", "a"]);
});

test("nothing within the radius is an empty list, not an error", () => {
  // The middle of Jamaica Bay.
  assert.deepEqual(nearbyStations(idx, [], 40.61, -73.84, radiusMetres(5)), []);
});
