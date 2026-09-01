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

test("a train long overdue at a stop it never reached is flagged, not drawn as if running", () => {
  const now = 1_788_000_000;
  const tracker = fresh();
  const train = oneTrain(now);
  tracker.ingest(at(now, [train]));
  assert.equal(tracker.states(now)[0].stale, undefined, "a fresh train is not stale");
  // The feed keeps republishing the same predictions while the clock runs past them.
  for (let i = 1; i <= 30; i++) tracker.ingest(at(now + i * 60, [train]));
  assert.equal(tracker.states(now + 1800)[0].stale, true, "half an hour past its own arrival is not a running train");
});

test("a train that is simply quiet is not mistaken for a ghost", () => {
  const now = 1_788_000_000;
  const tracker = fresh();
  // Predictions that stay put and a vehicle record that does not tick: normal for some feeds,
  // and it must not be read as the train having stopped existing.
  for (let i = 0; i <= 10; i++) {
    tracker.ingest(at(now + i * 60, [oneTrain(now, {
      stops: [
        { id: "119S", arrival: now + i * 60 + 300, departure: now + i * 60 + 300 },
        { id: "120S", arrival: now + i * 60 + 420, departure: now + i * 60 + 420 },
      ],
    })]));
  }
  assert.equal(tracker.states(now + 600)[0].stale, undefined, "a quiet but progressing train is fine");
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

test("a train parked at a platform far beyond any layover is flagged, even if its record twitches", () => {
  const now = 1_788_000_000;
  const tracker = fresh();
  // Arrives, then sits. Each tick changes its onward predictions slightly, so the record keeps
  // looking alive — which is exactly how one train stayed "at a platform" for 223 minutes.
  const parked = (t: number): TrainUpdate => oneTrain(now, {
    vehicle: { stopId: "119S", status: "STOPPED_AT", timestamp: now },
    stops: [
      { id: "119S", arrival: now, departure: now },
      { id: "120S", arrival: t + 300, departure: t + 300 },
      { id: "121S", arrival: t + 420, departure: t + 420 },
    ],
  });
  tracker.ingest(at(now, [parked(now)]));
  assert.equal(tracker.states(now)[0].stale, undefined, "a train that just arrived is not stale");
  for (let i = 1; i <= 45; i++) tracker.ingest(at(now + i * 60, [parked(now + i * 60)]));
  assert.equal(tracker.states(now + 2700)[0].stale, true, "45 minutes at one platform is not a running train");
});

test("a dwelling train never reports having arrived later than now", () => {
  const now = 1_788_000_000;
  const tracker = fresh();
  tracker.ingest(at(now, [oneTrain(now)]));
  // The lettered lines push this value ahead deliberately; it must not surface as a future arrival.
  tracker.ingest(at(now + 30, [oneTrain(now, {
    vehicle: { stopId: "119S", status: "STOPPED_AT", timestamp: now + 120 },
  })]));
  const state = tracker.states(now + 30)[0];
  assert.ok((state.arrivedAt ?? 0) <= now + 30, `arrivedAt ${state.arrivedAt} must not exceed the clock ${now + 30}`);
});

test("holding a train behind another keeps its whole run in order", () => {
  const now = 1_788_000_000;
  const tracker = fresh();
  // Two trains on the same track heading for the same platform: the follower's own prediction
  // has it arriving almost on top of the leader, which the clearance rule must push back.
  const leader: TrainUpdate = {
    id: "100000_1..S03R", route: "1", direction: "S", assigned: true, trainId: "01 A",
    vehicle: { stopId: "120S", status: "STOPPED_AT", timestamp: now - 20 },
    stops: [
      { id: "120S", arrival: now, departure: now },
      { id: "121S", arrival: now + 120, departure: now + 120 },
    ],
  };
  const follower: TrainUpdate = {
    id: "100100_1..S03R", route: "1", direction: "S", assigned: true, trainId: "01 B",
    vehicle: { stopId: "120S", status: "IN_TRANSIT_TO", timestamp: now - 5 },
    stops: [
      { id: "120S", arrival: now + 10, departure: now + 10 },
      { id: "121S", arrival: now + 40, departure: now + 40 },
      { id: "122S", arrival: now + 70, departure: now + 70 },
    ],
  };
  tracker.ingest(at(now, [leader, follower]));
  const behind = tracker.states(now).find((s) => s.id === follower.id)!;
  for (let i = 1; i < behind.stops.length; i++) {
    assert.ok(
      behind.stops[i].eta >= behind.stops[i - 1].eta,
      `after being held, ${behind.stops[i].id} must not precede ${behind.stops[i - 1].id}`,
    );
  }
});

test("one physical train published under two trip ids is drawn once", () => {
  const now = 1_788_000_000;
  const tracker = fresh();
  // The same carriages, as the feed sometimes reports them: a full trip id and a short
  // supplement form, sharing the MTA's own train identity.
  const full = oneTrain(now, { id: "099000_2..S01R", route: "2", trainId: "02 1630 241/FLA" });
  const short: TrainUpdate = {
    ...full,
    id: "099000_2..S",
    vehicle: undefined,
    stops: [{ id: "119S", arrival: now + 60, departure: now + 60 }],
  };
  tracker.ingest(at(now, [full, short]));
  const states = tracker.states(now);
  const sameTrain = states.filter((s) => s.trainId === "02 1630 241/FLA");
  assert.equal(sameTrain.length, 1, `one physical train, one marker — got ${sameTrain.map((s) => s.id).join(" + ")}`);
  assert.equal(sameTrain[0].id, "099000_2..S01R", "and it should be the better-informed record");
});

test("a train turning around at a terminal is one train, not two", () => {
  const now = 1_788_000_000;
  const tracker = fresh();
  const identity = "01 1200 SFT/VCP";
  // Inbound run, finishing at the terminal.
  const inbound = oneTrain(now, { id: "100000_1..S03R", trainId: identity });
  tracker.ingest(at(now, [inbound]));
  // The outbound run is assigned while the inbound trip is still being published: the same
  // carriages under two trip ids, which is what a turnaround looks like in the feed.
  const outbound: TrainUpdate = {
    id: "100500_1..N03R", route: "1", direction: "N", assigned: true, trainId: identity,
    vehicle: { stopId: "122N", status: "STOPPED_AT", timestamp: now + 60 },
    stops: [
      { id: "122N", arrival: now + 60, departure: now + 60 },
      { id: "121N", arrival: now + 180, departure: now + 180 },
    ],
  };
  tracker.ingest(at(now + 60, [inbound, outbound]));
  const drawn = tracker.states(now + 60).filter((s) => s.trainId === identity);
  assert.equal(drawn.length, 1, `a turnaround is one train — drew ${drawn.map((d) => d.id).join(" + ")}`);
});

/**
 * The B division never reports a departure. It parks a vehicle at STOPPED_AT for the whole run
 * and pushes its timestamp forward every 16 s; that beat freezing is the departure. These two
 * tests pin both halves, because getting either wrong moves trains that are standing at a
 * platform or strands trains that left a minute ago.
 */
/**
 * A pure heartbeat feed has to look like one before the tracker will treat it as one: the lag
 * correction is only applied to feeds that beat and never report a moving train, because the L
 * and the Staten Island Railway do both and their departures are not late.
 */
function warmHeartbeat(tracker: ReturnType<typeof fresh>, from: number): number {
  // Well before the scenario it precedes: a tick older than one already ingested is ignored, so
  // warming up *past* the start time silently discards everything the test then does.
  let t = from;
  for (let i = 0; i < 30; i++) {
    t += 16;
    tracker.ingest(at(t, [letteredTrain("A99S", t - 8, [
      { id: "A99S", arrival: from, departure: from },
      { id: "A98S", arrival: from + 600, departure: from + 600 },
    ], "WARM")]));
  }
  return t;
}

function letteredTrain(stop: string, vts: number, stops: TrainUpdate["stops"], id = "A_TEST"): TrainUpdate {
  return {
    id, route: "A", direction: "S", assigned: true,
    vehicle: { stopId: stop, status: "STOPPED_AT", timestamp: vts },
    stops,
  };
}

test("a running heartbeat never pins a lettered train to the platform", () => {
  const now = 1_788_000_000;
  const tracker = fresh();
  const plan = [
    { id: "A15S", arrival: now, departure: now },
    { id: "A16S", arrival: now + 200, departure: now + 200 },
  ];
  tracker.ingest(at(now, [letteredTrain("A15S", now, plan)]));
  let t = now;
  for (let i = 0; i < 25; i++) { t += 16; tracker.ingest(at(t, [letteredTrain("A15S", t - 8, plan)])); }
  const s = tracker.snapshot(t).trains.find((x) => x.id === "A_TEST")!;
  // Confirming a freeze takes 45 s, so the beat is never allowed to delay a departure — waiting
  // on it put the marker 470 m short of the platform against 185 m when measured.
  assert.equal(s.phase, "moving", "the modelled dwell decides when the marker starts moving");
  assert.ok(s.departedAt! <= now + 400, "and it is not held on the beat's account");
});

test("a heartbeat that froze early departs the train early", () => {
  const now = 1_788_000_000;
  const tracker = fresh();
  warmHeartbeat(tracker, now - 1200);
  const plan = [
    { id: "A15S", arrival: now, departure: now },
    { id: "A16S", arrival: now + 600, departure: now + 600 },
  ];
  tracker.ingest(at(now, [letteredTrain("A15S", now, plan)]));
  // Two beats, then silence: this train left after 32 s, well inside any modelled dwell.
  let t = now, frozen = now;
  for (let i = 0; i < 2; i++) { t += 16; frozen = t; tracker.ingest(at(t, [letteredTrain("A15S", frozen, plan)])); }
  for (let i = 0; i < 5; i++) { t += 16; tracker.ingest(at(t, [letteredTrain("A15S", frozen, plan)])); }
  const s = tracker.snapshot(t).trains.find((x) => x.id === "A_TEST")!;
  assert.equal(s.phase, "moving");
  // The beat may only ever move a departure earlier than the modelled dwell would, never later.
  assert.ok(s.departedAt! <= now + 90, "the beat should not delay a departure");
});

test("the final approach places a train near the platform, and never behind itself", () => {
  const now = 1_788_000_000;
  const tracker = fresh();
  const plan = [
    { id: "120S", arrival: now + 40, departure: now + 40 },
    { id: "121S", arrival: now + 130, departure: now + 130 },
  ];
  const t = (over: Partial<TrainUpdate["vehicle"]>) => oneTrain(now, {
    id: "1_APPROACH", vehicle: { stopId: "119S", status: "STOPPED_AT", timestamp: now - 60, ...over },
    stops: plan,
  });
  tracker.ingest(at(now - 60, [t({})]));
  tracker.ingest(at(now - 20, [t({ stopId: "120S", status: "IN_TRANSIT_TO", timestamp: now - 20 })]));
  const before = tracker.snapshot(now - 20).trains.find((x) => x.id === "1_APPROACH")!;
  assert.equal(before.approach, undefined, "no approach reported yet");
  tracker.ingest(at(now, [t({ stopId: "120S", status: "INCOMING_AT", timestamp: now })]));
  const after = tracker.snapshot(now).trains.find((x) => x.id === "1_APPROACH")!;
  assert.ok(after.approach, "INCOMING_AT is the one position the feed ever gives us");
  assert.equal(after.approach!.since, now);
  assert.ok(after.approach!.typical > 0 && after.approach!.typical < 120, "a plausible approach time");
});

test("a lettered train's frozen heartbeat is recorded as a real departure event", () => {
  const now = 1_788_000_000;
  const tracker = fresh();
  warmHeartbeat(tracker, now - 1200);
  const plan = (a: string, b: string) => [
    { id: a, arrival: now, departure: now },
    { id: b, arrival: now + 200, departure: now + 200 },
  ];
  tracker.ingest(at(now, [letteredTrain("A15S", now, plan("A15S", "A16S"))]));
  let t = now, frozen = now;
  for (let i = 0; i < 4; i++) { t += 16; frozen = t - 8; tracker.ingest(at(t, [letteredTrain("A15S", frozen, plan("A15S", "A16S"))])); }
  // It reappears at the next stop, still STOPPED_AT — the transition the B division always makes.
  t += 60;
  const ev = tracker.ingest(at(t, [letteredTrain("A16S", t, plan("A16S", "A17S"))]));
  const dep = ev.events.find((e) => e.kind === "depart" && e.stopId === "A15S");
  assert.ok(dep, "the frozen beat is the departure signal, and the only one this feed will ever give");
  // The freeze is the signal, not the moment: on a feed that only ever beats, it runs on about
  // 25 s past the departure — measured three ways, including a 24 s gap between the divisions'
  // dwell at the same station. What is recorded is the freeze less that lag.
  assert.ok(dep!.ts < frozen, `the departure should precede the freeze, got ${dep!.ts - frozen} s`);
  assert.ok(frozen - dep!.ts >= 20, `expected roughly the measured lag, got ${frozen - dep!.ts} s`);
  assert.ok(dep!.ts > now, "and never before it arrived");
  assert.equal(dep!.estimated, false, "it is a real feed timestamp, so the learner may use it");
});
