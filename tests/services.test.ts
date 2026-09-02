/**
 * Every service, deliberately. Each of these has produced a bug at least once: the shuttles get
 * forgotten because they are small, the Staten Island Railway because the feed calls it something
 * else, and the express variants because they only run at rush hour and are invisible the rest of
 * the day.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NetworkIndex } from "../src/lib/network";
import { canonicalRoute } from "../src/lib/feed";
import { isExpress } from "../src/components/brand/RouteBullet";
import type { Network } from "../src/lib/types";

const net = new NetworkIndex(JSON.parse(readFileSync(join(process.cwd(), "public/data/network.json"), "utf8")) as Network);

const TRUNKS = ["1", "2", "3", "4", "5", "6", "7", "A", "C", "E", "B", "D", "F", "M", "N", "Q", "R", "W", "G", "J", "Z", "L"];
const SHUTTLES = ["GS", "FS", "H"];
const EXPRESS = ["6X", "7X", "FX"];

test("every service the schedule contains is drawable", () => {
  for (const route of [...TRUNKS, ...SHUTTLES, ...EXPRESS, "SI"]) {
    const r = net.net.routes[route];
    assert.ok(r, `${route} should exist in the network`);
    assert.match(r.color, /^#[0-9A-Fa-f]{6}$/, `${route} needs a real colour, got ${r.color}`);
    const runs = net.net.routeRuns[route] ?? [];
    assert.ok(runs.length > 0, `${route} has no drawable geometry`);
    const stops = runs.flatMap((run) => run.stops);
    assert.ok(stops.length > 0, `${route} has runs but no stops`);
    for (const s of stops.slice(0, 40)) assert.ok(net.station(s), `${route} run references unknown station ${s}`);
  }
});

test("the shuttles are short, self-contained lines and not mistaken for trunks", () => {
  for (const route of SHUTTLES) {
    const stations = new Set((net.net.routeRuns[route] ?? []).flatMap((r) => r.stops));
    assert.ok(stations.size >= 2, `${route} should link at least two stations`);
    assert.ok(stations.size <= 15, `${route} is a shuttle, not a trunk (${stations.size} stations)`);
  }
});

test("the Staten Island Railway is reachable under either name the MTA uses", () => {
  assert.equal(canonicalRoute("SS"), "SI");
  assert.ok(net.net.routes.SI, "SI must be a known route");
  const stations = new Set((net.net.routeRuns.SI ?? []).flatMap((r) => r.stops));
  assert.ok(stations.size > 10, `the SIR runs the length of the island, got ${stations.size} stations`);
});

test("express services are marked as express and share their local's colour", () => {
  for (const x of EXPRESS) {
    assert.ok(isExpress(x), `${x} should render as a diamond`);
    const local = x.replace(/X$/, "");
    assert.equal(net.net.routes[x].color, net.net.routes[local].color, `${x} runs on the ${local}'s line and takes its colour`);
  }
  assert.ok(!isExpress("6"), "the local is not express");
});

test("every station belongs to exactly one complex, and every complex names itself", () => {
  for (const id of Object.keys(net.net.stations)) {
    const key = net.complexKey(id);
    const complex = net.net.complexes[key];
    assert.ok(complex, `${id} maps to complex ${key}, which does not exist`);
    assert.ok(complex.stations.includes(id), `${id} is not listed in its own complex`);
    assert.ok(complex.name.length > 0, `complex ${key} has no name`);
    assert.ok(complex.routes.length > 0, `complex ${key} (${complex.name}) serves no routes`);
  }
});

test("every lane a route occupies is one the corridor actually has", () => {
  for (const [key, slots] of Object.entries(net.net.segmentSlots)) {
    for (const [route, [slot, shared]] of Object.entries(slots)) {
      assert.ok(shared >= 1, `${key}/${route} claims ${shared} lanes`);
      assert.ok(Math.abs(slot) <= (shared - 1) / 2 + 0.001, `${key}/${route} sits at lane ${slot} of ${shared}`);
    }
  }
});
