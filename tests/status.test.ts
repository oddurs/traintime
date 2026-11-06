/**
 * The train taxonomy — see TrainStatus. Each status is pinned from the feed evidence it is meant
 * to be decided by, and each boundary from the case that would blur it with its neighbour.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NetworkIndex } from "../src/lib/network";
import { Timing } from "../src/lib/timing";
import { Tracker, nySecondsOfDay, tripStart } from "../src/lib/tracker";
import { HELD_S, type FeedTick, type Network, type TrainUpdate } from "../src/lib/types";

const net = new NetworkIndex(JSON.parse(readFileSync(join(process.cwd(), "public/data/network.json"), "utf8")) as Network);
const fresh = () => new Tracker(net, new Timing(net));
const at = (ts: number, trains: TrainUpdate[]): FeedTick => ({ feed: "gtfs", ts, fetchedAt: ts, trains });
const NOW = 1_788_000_000;

/** A NYCT trip id for a trip leaving its first stop at `start`: hundredths of a minute past midnight. */
function tripId(start: number, suffix = "1..S03R"): string {
  const minutes = (nySecondsOfDay(start) / 60) * 100;
  return `${String(Math.round(minutes)).padStart(6, "0")}_${suffix}`;
}

function train(over: Partial<TrainUpdate>): TrainUpdate {
  return {
    id: tripId(NOW - 3600), route: "1", direction: "S", assigned: true, trainId: "01 1200 VCP/SFT",
    stops: [
      { id: "119S", arrival: NOW + 60, departure: NOW + 60 },
      { id: "120S", arrival: NOW + 150, departure: NOW + 150 },
      { id: "121S", arrival: NOW + 240, departure: NOW + 240 },
    ],
    ...over,
  };
}

test("a trip with no train yet is scheduled", () => {
  const tracker = fresh();
  tracker.ingest(at(NOW, [train({ stops: [{ id: "119S", arrival: NOW + 900, departure: NOW + 900 }, { id: "120S", arrival: NOW + 990, departure: NOW + 990 }] })]));
  const [st] = tracker.states(NOW);
  assert.equal(st.status, "scheduled");
  assert.equal(st.phase, "unstarted");
});

test("a train heading for the first stop of a trip that has not begun is preparing, and parked there", () => {
  const tracker = fresh();
  const start = NOW + 1200;
  tracker.ingest(at(NOW, [train({
    id: tripId(start),
    vehicle: { stopId: "119S", status: "IN_TRANSIT_TO", timestamp: NOW - 10 },
    stops: [{ id: "119S", arrival: start, departure: start }, { id: "120S", arrival: start + 90, departure: start + 90 }],
  })]));
  const [st] = tracker.states(NOW);
  assert.equal(st.status, "preparing");
  // Parked at its first stop, not drawn on the track short of it.
  assert.equal(st.phase, "unstarted");
  assert.equal(st.nextStop, "119S");
  assert.ok(Math.abs((st.startsAt ?? 0) - start) < 60, `starts at ${st.startsAt}, expected about ${start}`);
});

test("a train first seen mid-route is running, whatever its trip id says about a start hours away", () => {
  // After a restart nothing has been seen to leave anywhere, and the id of an evening trip read in
  // the morning says it starts in ten hours. That is not a train making ready.
  const tracker = fresh();
  tracker.ingest(at(NOW, [train({ id: tripId(NOW + 10 * 3600), vehicle: { stopId: "119S", status: "IN_TRANSIT_TO", timestamp: NOW - 10 } })]));
  assert.equal(tracker.states(NOW)[0].status, "running");
});

test("a train between stations past its usual run time by more than HELD_S is held, for that long", () => {
  const tracker = fresh();
  const leave = NOW + 30;
  tracker.ingest(at(NOW, [train({ vehicle: { stopId: "119S", status: "STOPPED_AT", timestamp: NOW } })]));
  tracker.ingest(at(leave, [train({
    vehicle: { stopId: "120S", status: "IN_TRANSIT_TO", timestamp: leave },
    stops: [{ id: "120S", arrival: leave + 90, departure: leave + 90 }, { id: "121S", arrival: leave + 180, departure: leave + 180 }],
  })]));
  const running = tracker.states(leave + 10)[0];
  assert.equal(running.status, "running");
  assert.ok(running.runTime && running.departedAt, "the departure and the run time are both known");

  const late = running.departedAt! + running.runTime! + HELD_S + 240;
  const held = tracker.states(late)[0];
  assert.equal(held.status, "held");
  assert.ok(Math.abs((held.heldFor ?? 0) - (HELD_S + 240)) < 2, `held for ${held.heldFor}`);
});

test("a train at a platform past its departure is held there; at the end of the line it is laying over", () => {
  const tracker = fresh();
  tracker.ingest(at(NOW, [train({ vehicle: { stopId: "119S", status: "STOPPED_AT", timestamp: NOW } })]));
  const st = tracker.states(NOW)[0];
  assert.equal(st.status, "at-platform");
  const due = st.expectedDeparture!;
  // Still at the platform, the feed still saying so, well past when it should have gone.
  tracker.ingest(at(due + HELD_S + 60, [train({ vehicle: { stopId: "119S", status: "STOPPED_AT", timestamp: NOW } })]));
  const held = tracker.states(due + HELD_S + 60)[0];
  assert.equal(held.phase, "dwelling");
  assert.equal(held.status, "held");

  const terminal = fresh();
  const last = [{ id: "142S", arrival: NOW, departure: NOW }];
  terminal.ingest(at(NOW, [train({ vehicle: { stopId: "142S", status: "STOPPED_AT", timestamp: NOW }, stops: last })]));
  terminal.ingest(at(NOW + 900, [train({ vehicle: { stopId: "142S", status: "STOPPED_AT", timestamp: NOW }, stops: last })]));
  assert.equal(terminal.states(NOW + 900)[0].status, "at-platform", "a layover at the terminal is the schedule");
});

test("trip ids read as the start time nearest now, across midnight", () => {
  const midnight = NOW - nySecondsOfDay(NOW);
  // 23:50 the evening before, read at 00:10.
  assert.equal(tripStart("143000_1..S", midnight + 600, 600), midnight - 600);
  // 00:20, read at 23:50: the next service day's early trip, or the same day's 24:20 — both are 30 min on.
  assert.equal(tripStart("002000_1..S", midnight + 86_400 - 600, 86_400 - 600), midnight + 86_400 + 1200);
  assert.equal(tripStart("not-a-nyct-id", NOW, 0), undefined);
});

// ---------- the rules the replay audit changed (scripts/audit-status.ts) ----------

test("a train overdue but still being revised is held, not lost; one the feed has stopped revising is lost", () => {
  // Replayed over 9.5 h, "overdue" alone called 101 trains lost and 46 of them were moving again
  // afterwards: a long hold at a signal is overdue too, and the feed goes on reporting it.
  const run = (revised: boolean) => {
    const tracker = fresh();
    tracker.ingest(at(NOW, [train({ vehicle: { stopId: "119S", status: "STOPPED_AT", timestamp: NOW } })]));
    const next = [{ id: "120S", arrival: NOW + 120, departure: NOW + 120 }, { id: "121S", arrival: NOW + 210, departure: NOW + 210 }];
    for (let t = NOW + 30; t <= NOW + 1500; t += 60) {
      tracker.ingest(at(t, [train({ vehicle: { stopId: "120S", status: "IN_TRANSIT_TO", timestamp: revised ? t : NOW + 30 }, stops: next })]));
    }
    return tracker.states(NOW + 1500)[0].status;
  };
  assert.equal(run(true), "held");
  assert.equal(run(false), "lost");
});

test("on a heartbeat feed, a train is not called held at a platform once its heartbeat has stopped", () => {
  // The lettered lines report a stand as a timestamp that advances every 16 s and freezes after
  // the train leaves; STOPPED_AT outlives the departure. Replayed, 95% of the platform holds called
  // there were trains that had already gone. A silent heartbeat is the train having left.
  const tracker = fresh();
  const end = NOW + 600;
  for (let t = NOW; t <= end; t += 16) {
    tracker.ingest({ feed: "gtfs-bdfm", ts: t, fetchedAt: t, trains: [train({
      route: "D", vehicle: { stopId: "119S", status: "STOPPED_AT", timestamp: Math.min(t, NOW + 32) },
    })] });
  }
  const st = tracker.states(end)[0];
  // It is past due somewhere — but it left: dated from its last beat, it is between stations.
  assert.equal(st.phase, "moving");
  assert.ok(Math.abs((st.departedAt ?? 0) - (NOW + 32)) < 20, `departed ${st.departedAt! - NOW} s in, at the last beat`);
});

test("a trip with no train in it, a minute before its start, is scheduled rather than running", () => {
  const tracker = fresh();
  const start = NOW + 40;
  tracker.ingest(at(NOW, [train({ id: tripId(start), stops: [{ id: "119S", arrival: start, departure: start }, { id: "120S", arrival: start + 90, departure: start + 90 }] })]));
  assert.equal(tracker.states(NOW)[0].status, "scheduled");
});
