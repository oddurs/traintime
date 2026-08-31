/**
 * Behaviour tests for the tracker, built from synthetic feed ticks. Each one pins a defect the
 * August 2026 audit found, so a regression fails here rather than on the map.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NetworkIndex } from "../src/lib/network";
import { Timing } from "../src/lib/timing";
import { Tracker } from "../src/lib/tracker";
import { canonicalRoute, normalize } from "../src/lib/feed";
import type { FeedTick, Network, TrainUpdate } from "../src/lib/types";

const net = new NetworkIndex(JSON.parse(readFileSync(join(process.cwd(), "public/data/network.json"), "utf8")) as Network);
const fresh = () => new Tracker(net, new Timing(net));
const at = (ts: number, trains: TrainUpdate[]): FeedTick => ({ feed: "gtfs", ts, fetchedAt: ts, trains });

/** A southbound 1 train running down the west side, with deliberately awkward predictions. */
function oneTrain(now: number, over: Partial<TrainUpdate> = {}): TrainUpdate {
  return {
    id: "100000_1..S03R",
    route: "1",
    direction: "S",
    assigned: true,
    trainId: "01 1200 VCP/SFT",
    vehicle: { stopId: "119S", status: "IN_TRANSIT_TO", timestamp: now - 10 },
    stops: [
      { id: "119S", arrival: now + 60, departure: now + 60 },
      { id: "120S", arrival: now + 150, departure: now + 150 },
      { id: "121S", arrival: now + 240, departure: now + 240 },
      { id: "122S", arrival: now + 330, departure: now + 330 },
    ],
    ...over,
  };
}

test("predicted stop times never run backwards", () => {
  const now = 1_788_000_000;
  const tracker = fresh();
  tracker.ingest(at(now, [oneTrain(now)]));
  const [state] = tracker.states(now);
  assert.ok(state, "the train should be tracked");
  for (let i = 1; i < state.stops.length; i++) {
    assert.ok(
      state.stops[i].eta >= state.stops[i - 1].eta,
      `stop ${state.stops[i].id} (${state.stops[i].eta}) must not precede ${state.stops[i - 1].id} (${state.stops[i - 1].eta})`,
    );
  }
});

test("stops the schedule has never heard of are left out, and the terminal is still nameable", () => {
  const now = 1_788_000_000;
  const tracker = fresh();
  // X22 is a yard track the realtime feed references and the published schedule does not.
  const train = oneTrain(now, {
    stops: [
      { id: "119S", arrival: now + 60, departure: now + 60 },
      { id: "120S", arrival: now + 150, departure: now + 150 },
      { id: "X22S", arrival: now + 400, departure: now + 400 },
    ],
  });
  tracker.ingest(at(now, [train]));
  const [state] = tracker.states(now);
  assert.ok(!state.stops.some((s) => s.id.startsWith("X22")), "an unschedulable stop must not be shown");
  assert.ok(net.station(state.destination!), `destination ${state.destination} should be a real station`);
  assert.ok(tracker.unknownStops.has("X22"), "but it should be reported");
});

test("the Staten Island Railway is one service, whatever the feed calls it", () => {
  assert.equal(canonicalRoute("SS"), "SI");
  assert.equal(canonicalRoute("1"), "1");
  const decoded = normalize({
    entity: [{
      tripUpdate: {
        trip: { tripId: "112600_SI.S07R", routeId: "SS" },
        stopTimeUpdate: [{ stopId: "S18S", arrival: { time: 1_788_000_100 } }],
      },
    }],
  });
  assert.equal(decoded[0].route, "SI", "the feed's SS is the schedule's SI");
  assert.ok(net.net.routes[decoded[0].route], "and it must resolve to a known route");
});

test("a train the feed stops updating is marked stale rather than presented as running", () => {
  const now = 1_788_000_000;
  const tracker = fresh();
  const train = oneTrain(now);
  tracker.ingest(at(now, [train]));
  assert.equal(tracker.states(now)[0].stale, undefined, "a fresh train is not stale");
  // The feed keeps republishing the identical tick for an hour: nothing about the train changes.
  for (let i = 1; i <= 60; i++) tracker.ingest(at(now + i * 60, [train]));
  const later = tracker.states(now + 3600)[0];
  assert.equal(later.stale, true, "an unchanging train must be flagged, not drawn as if it were moving");
});

test("a vehicle timestamp from the future is not taken at face value", () => {
  const now = 1_788_000_000;
  const tracker = fresh();
  tracker.ingest(at(now, [oneTrain(now)]));
  // Same train, now claiming to have arrived ten minutes from now.
  tracker.ingest(at(now + 30, [oneTrain(now, {
    vehicle: { stopId: "119S", status: "STOPPED_AT", timestamp: now + 600 },
  })]));
  const state = tracker.states(now + 30)[0];
  assert.ok((state.arrivedAt ?? 0) <= now + 35, `arrivedAt ${state.arrivedAt} must not be ahead of the clock`);
});
