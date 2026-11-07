/** Opening and closing places as history entries, against a browser history kept in memory. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { closePlace, openPlace, parseHash, placeDepth, writeHash } from "../src/lib/urlState";

/** The few parts of window the history functions touch, with a real stack behind them. */
function fakeWindow(hash = "") {
  const stack: { state: unknown; hash: string }[] = [{ state: null, hash }];
  let at = 0;
  const location = { pathname: "/", search: "", get hash() { return stack[at].hash; } };
  const history = {
    get state() { return stack[at].state; },
    pushState(state: unknown, _: string, url: string) { stack.splice(at + 1); stack.push({ state, hash: url.replace(/^[^#]*/, "") }); at++; },
    replaceState(state: unknown, _: string, url: string) { stack[at] = { state, hash: url.replace(/^[^#]*/, "") }; },
    back() { if (at > 0) at--; },
  };
  (globalThis as { window?: unknown }).window = { location, history };
  return { stack: () => stack.slice(0, at + 1).map((e) => e.hash), location };
}

test("opening a station and then a train is two steps back to the map", () => {
  const w = fakeWindow();
  openPlace({ station: "L08" });
  openPlace({ train: "069650_L..N" });
  assert.deepEqual(w.stack(), ["", "#s=L08", "#t=069650_L..N"]);
  assert.equal(placeDepth(), 2);
  assert.ok(closePlace());
  assert.equal(parseHash(w.location.hash).station, "L08");
  assert.ok(closePlace());
  assert.equal(w.location.hash, "");
  assert.equal(placeDepth(), 0);
});

test("moving the map does not add a step, and does not lose how deep the entry is", () => {
  const w = fakeWindow();
  openPlace({ station: "L08" });
  writeHash({ station: "L08", view: { lat: 40.7, lon: -73.9, zoom: 14 } });
  assert.equal(w.stack().length, 2);
  assert.equal(placeDepth(), 1);
});

test("a station opened by a link has nothing of ours behind it, so it closes in place", () => {
  fakeWindow("#s=L08");
  assert.equal(placeDepth(), 0);
  assert.equal(closePlace(), false);
});

import { MAX_RECENTS, remember } from "../src/lib/recents";

test("a recent station moves to the front instead of appearing twice, and the list is bounded", () => {
  let list = remember([], "A", "Alpha", 1);
  list = remember(list, "B", "Beta", 2);
  list = remember(list, "A", "Alpha", 3);
  assert.deepEqual(list.map((r) => r.id), ["A", "B"]);
  for (let i = 0; i < 20; i++) list = remember(list, `S${i}`, `Station ${i}`, 10 + i);
  assert.equal(list.length, MAX_RECENTS);
  assert.equal(list[0].id, "S19");
});

import { fmtSpread, fmtWhen } from "../src/lib/format";

test("times are in one unit, and the uncertainty is only said when it changes what a rider does", () => {
  assert.equal(fmtWhen(10), "now");
  assert.equal(fmtWhen(35), "1 min");
  assert.equal(fmtWhen(144), "2 min");
  assert.equal(fmtWhen(600), "10 min");
  assert.equal(fmtSpread(32), null);
  assert.equal(fmtSpread(95), "± 2 min");
});
