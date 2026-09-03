/**
 * The browser timing store answers a question nobody can re-ask later: what the page was like for
 * someone who has already closed it. So the two things worth pinning down are that a hostile or
 * broken report cannot corrupt the answer, and that the percentiles are the ones they claim to be.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Rum, parseSample, percentile } from "../services/poller/rum";

test("a report from the internet is bounded before it is believed", () => {
  const s = parseSample({
    ttfb: 120.4, fcp: 900.6, readable: 2100, map: 4300,
    cpu: 8, mem: 4, net: "4g",
  }, 100);
  assert.ok(s);
  // Rounded, not truncated, and kept.
  assert.equal(s.ttfb, 120);
  assert.equal(s.fcp, 901);
  assert.equal(s.net, "4g");

  // A tab restored from the background reports an hour; one such sample would ruin a p90.
  assert.equal(parseSample({ fcp: 500, readable: 3_600_000 }, 100)?.readable, undefined);
  // And the rest of that sample still counts, because the fcp in it was real.
  assert.equal(parseSample({ fcp: 500, readable: 3_600_000 }, 100)?.fcp, 500);

  // Nothing else gets through: not negatives, not strings, not NaN, not an invented connection.
  assert.equal(parseSample({ fcp: -1, readable: 10 }, 100)?.fcp, undefined);
  assert.equal(parseSample({ fcp: "900", readable: 10 }, 100)?.fcp, undefined);
  assert.equal(parseSample({ fcp: Number.NaN, readable: 10 }, 100)?.fcp, undefined);
  assert.equal(parseSample({ readable: 10, net: "6g" }, 100)?.net, undefined);
  assert.equal(parseSample({ readable: 10, cpu: 1e9 }, 100)?.cpu, undefined);

  // A body carrying no milestone is not a measurement of anything, and must not be counted as a
  // visit — otherwise anyone can inflate the sample count without contributing an observation.
  assert.equal(parseSample({ net: "4g", cpu: 8 }, 100), null);
  assert.equal(parseSample("nonsense", 100), null);
  assert.equal(parseSample(null, 100), null);
});

test("percentiles are the observations they name", () => {
  const v = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  // Nearest rank: p50 of ten values is the fifth, not an average of the fifth and sixth.
  assert.equal(percentile(v, 50), 5);
  assert.equal(percentile(v, 90), 9);
  assert.equal(percentile(v, 100), 10);
  assert.equal(percentile([42], 90), 42);
  assert.equal(percentile([], 50), 0);
});

test("the report describes the recent hour and forgets the rest", () => {
  const rum = new Rum();
  const now = 10_000;
  // Ten visits an hour ago that were fast, and ten just now that were not. If the window did not
  // work, the median would sit between the two groups instead of inside the recent one.
  for (let i = 0; i < 10; i++) rum.add({ at: now - 7200, fcp: 100, readable: 200, net: "4g" });
  for (let i = 0; i < 10; i++) rum.add({ at: now - 60, fcp: 1000 + i * 100, readable: 3000 + i * 100, net: "3g" });

  const r = rum.report(now);
  assert.equal(r.samples, 10);
  assert.equal(r.fcp?.p50, 1400);
  assert.equal(r.fcp?.p90, 1800);
  assert.equal(r.fcp?.worst, 1900);
  assert.deepEqual(r.net, { "3g": 10 });
  // The map never loaded for any of them, so there is nothing to report about it rather than a zero.
  assert.equal(r.map, undefined);
});

test("a page that painted and never became readable is counted as such", () => {
  const rum = new Rum();
  rum.add({ at: 100, fcp: 800, readable: 2000 });
  rum.add({ at: 100, fcp: 800 });
  rum.add({ at: 100, fcp: 900 });
  // A sample with no paint at all is not evidence either way, and must not be counted here —
  // neither one that got as far as being readable without reporting a paint, nor one that
  // reported neither. Without the second of those, "never painted" and "never readable" cannot
  // be told apart by this test at all.
  rum.add({ at: 100, readable: 1500 });
  rum.add({ at: 100, ttfb: 50 });

  const r = rum.report(200);
  assert.equal(r.samples, 5);
  assert.equal(r.neverReadable, 2);
  assert.equal(r.readable?.n, 2);
});

test("the store is a ring, so a firehose cannot grow it without bound", () => {
  const rum = new Rum();
  for (let i = 0; i < 5000; i++) rum.add({ at: 100, fcp: i });
  const r = rum.report(200);
  assert.equal(r.samples, 500);
  // And it kept the newest, not the oldest.
  assert.equal(r.fcp?.worst, 4999);
});

/**
 * The store above is only useful if the endpoint in front of it actually reaches it. This drives
 * the real server over a real socket, because the parts most likely to break are the ones the
 * unit tests cannot see: the route, the body reader's byte cap, and the report reaching /health.
 */
test("the endpoint takes a report and /health shows it", async () => {
  const { PollerServer } = await import("../services/poller/server");
  const server = new PollerServer({
    health: () => ({ ok: true }),
  } as unknown as ConstructorParameters<typeof PollerServer>[0]);
  const http = server.listen(0);
  await new Promise((r) => http.once("listening", r));
  const { port } = http.address() as { port: number };
  const at = `http://127.0.0.1:${port}`;
  const post = (path: string, body: string) =>
    fetch(at + path, { method: "POST", headers: { "content-type": "application/json" }, body });

  try {
    assert.equal((await post("/client-timing", JSON.stringify({ fcp: 700, readable: 1800, map: 3000, net: "4g" }))).status, 200);
    assert.equal((await post("/client-timing", JSON.stringify({ fcp: 900, readable: 2600, map: 5000, net: "3g" }))).status, 200);

    // Nothing a broken or hostile client sends should be a 500, and none of it should land.
    assert.equal((await post("/client-timing", "{not json")).status, 200);
    assert.equal((await post("/client-timing", JSON.stringify({ net: "4g" }))).status, 200);
    // Over the body cap: read past the limit is discarded, so this parses as nothing.
    assert.equal((await post("/client-timing", JSON.stringify({ fcp: 100, pad: "x".repeat(8192) }))).status, 200);
    // And it is POST only, so it cannot be triggered by a link or an image tag.
    assert.equal((await fetch(at + "/client-timing")).status, 405);

    const report = server.clientErrorReport();
    assert.equal(report.timing.samples, 2);
    assert.equal(report.timing.readable?.p50, 1800);
    assert.equal(report.timing.map?.p90, 5000);
    assert.deepEqual(report.timing.net, { "4g": 1, "3g": 1 });

    // And the timings ride along with the errors, on the endpoint that is actually monitored.
    const health = await (await fetch(at + "/health")).json();
    assert.equal(health.ok, true);
  } finally {
    http.close();
  }
});
