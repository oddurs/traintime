/**
 * A trip cannot go back to a platform it has left. The lettered feeds briefly republish a trip's
 * older position and then carry on; believed, each one jumped a train back along the line — 163
 * trips in 9.5 h of replay. Each rule below is pinned from the feed behaviour it answers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NetworkIndex } from "../src/lib/network";
import { Timing } from "../src/lib/timing";
import { Tracker } from "../src/lib/tracker";
import type { FeedTick, Network, TrainUpdate, VehicleStatus } from "../src/lib/types";

const net = new NetworkIndex(JSON.parse(readFileSync(join(process.cwd(), "public/data/network.json"), "utf8")) as Network);
const NOW = 1_788_000_000;
const PLAN = ["119S", "120S", "121S", "122S"];

/** The trip, reported at `stop` with the stop list from there on. */
function at(ts: number, stop: string, vts: number, status: VehicleStatus = "STOPPED_AT"): FeedTick {
  const from = PLAN.indexOf(stop);
  const u: TrainUpdate = {
    id: "100000_1..S03R", route: "1", direction: "S", assigned: true,
    vehicle: { stopId: stop, status, timestamp: vts },
    stops: PLAN.slice(from).map((id, i) => ({ id, arrival: ts + i * 90, departure: ts + i * 90 })),
  };
  return { feed: "gtfs", ts, fetchedAt: ts, trains: [u] };
}

/** At 119S, then at 120S: it has left 119S. */
function moved(): Tracker {
  const tracker = new Tracker(net, new Timing(net));
  tracker.ingest(at(NOW, "119S", NOW));
  tracker.ingest(at(NOW + 90, "120S", NOW + 90));
  return tracker;
}
const where = (tracker: Tracker, t: number) => tracker.states(t, { predictions: false })[0];

test("a report placing a trip back at a platform it has left is ignored", () => {
  const tracker = moved();
  const out = tracker.ingest(at(NOW + 105, "119S", NOW + 100));
  assert.equal(out.events.filter((e) => e.stopId === "119S").length, 0, "no second arrival at 119S is recorded");
  const st = where(tracker, NOW + 105);
  assert.notEqual(st.nextStop, "119S", "and the train is not drawn back there");
  // And it is not forgotten for being out of step: still listed means still tracked.
  tracker.expire(NOW + 200);
  assert.equal(tracker.size, 1);
});

test("a stale record republished for any length of time never moves a trip back", () => {
  const tracker = moved();
  // A vehicle timestamp older than what we already have, for ten minutes.
  for (let t = NOW + 105; t <= NOW + 705; t += 30) tracker.ingest(at(t, "119S", NOW + 50));
  assert.notEqual(where(tracker, NOW + 705).nextStop, "119S");
});

test("a heartbeat at the platform it went back to is believed within a minute", () => {
  // The train really is there: the stop ahead was the glitch. A timestamp advancing every 16 s is
  // a train standing at a platform, and three of them over 45 s is the hold seen happening.
  const tracker = moved();
  for (let i = 0; i <= 4; i++) tracker.ingest(at(NOW + 105 + i * 16, "119S", NOW + 100 + i * 16));
  const st = where(tracker, NOW + 170);
  assert.equal(st.nextStop, "119S");
  assert.equal(tracker.regressions.accepted.has("100000_1..S03R"), true);
});

test("newer reports without a heartbeat are believed only once they have persisted for five minutes", () => {
  const tracker = moved();
  for (let t = NOW + 105; t <= NOW + 345; t += 30) tracker.ingest(at(t, "119S", NOW + 100));
  assert.notEqual(where(tracker, NOW + 345).nextStop, "119S", "four minutes is still a glitch");
  for (let t = NOW + 375; t <= NOW + 435; t += 30) tracker.ingest(at(t, "119S", NOW + 100));
  assert.equal(where(tracker, NOW + 435).nextStop, "119S", "past five, the forward position was the wrong one");
});
