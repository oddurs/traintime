/**
 * How the system behaves when the feeds misbehave. The dangerous failure is not the loud one:
 * a feed that 404s is obvious, while a feed that keeps returning 200 with a frozen timestamp
 * looks perfectly healthy while the trains quietly stop moving.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FeedMonitor } from "../services/poller/health";

const defs = [{ id: "gtfs", cadence: 5 }, { id: "gtfs-ace", cadence: 15 }];

test("a failing feed backs off, trips its breaker, and does not take the others with it", () => {
  const m = new FeedMonitor(defs);
  const t0 = 1_788_000_000;
  m.succeeded("gtfs-ace", t0, 100, t0);

  let last = 0;
  for (let i = 1; i <= 10; i++) {
    m.failed("gtfs", "HTTP 503", 50, t0 + i);
    const delay = m.nextDelayMs("gtfs", 50);
    assert.ok(delay >= 750, "a failing feed must wait before retrying");
    assert.ok(delay <= 90_000, "but never longer than a minute and a half");
    if (i > 1) assert.ok(delay >= last * 0.5, "the wait should grow, allowing for jitter");
    last = delay;
  }
  assert.ok(m.get("gtfs").backingOff, "ten straight failures should open the breaker");
  assert.equal(m.get("gtfs").ok, false);

  // The healthy feed is untouched, and the summary names only the sick one.
  const summary = m.summary(t0 + 20);
  assert.equal(summary.healthy, 1, "one feed is still fine");
  assert.deepEqual(summary.degraded.map((d) => d.id), ["gtfs"]);

  // And it recovers cleanly.
  m.succeeded("gtfs", t0 + 30, 120, t0 + 30);
  assert.equal(m.get("gtfs").ok, true);
  assert.equal(m.get("gtfs").backingOff, false);
  assert.equal(m.get("gtfs").consecutiveErrors, 0);
  assert.equal(m.summary(t0 + 30).healthy, 2);
});

test("a feed that keeps answering with a frozen timestamp is caught, not trusted", () => {
  const m = new FeedMonitor(defs);
  const t0 = 1_788_000_000;
  // Keep the other feed genuinely healthy throughout, so this is about the stalled one only.
  const healthyOther = (at: number) => m.succeeded("gtfs-ace", at, 90, at);
  healthyOther(t0);
  // Ten minutes of successful fetches, all carrying the same header timestamp.
  for (let i = 0; i < 120; i++) m.succeeded("gtfs", t0, 90, t0 + i * 5);
  healthyOther(t0 + 595);
  const f = m.get("gtfs");
  assert.equal(f.ok, true, "every request succeeded, which is exactly what makes this dangerous");
  assert.equal(m.summary(t0 + 600).degraded.some((d) => d.id === "gtfs" && d.why === "stalled"), true,
    "a feed whose contents stop advancing must be reported as degraded");
  assert.equal(m.summary(t0 + 600).healthy, 1, "the stalled feed must not be counted among the healthy ones");

  // A fresh timestamp clears it immediately.
  m.succeeded("gtfs", t0 + 601, 90, t0 + 601);
  healthyOther(t0 + 601);
  assert.equal(m.summary(t0 + 601).degraded.length, 0, "and nothing is left degraded");
});

test("a feed polls at its own cadence when it is well", () => {
  const m = new FeedMonitor(defs);
  const t0 = 1_788_000_000;
  m.succeeded("gtfs", t0, 200, t0);
  const fast = m.nextDelayMs("gtfs", 200);
  m.succeeded("gtfs-ace", t0, 200, t0);
  const slow = m.nextDelayMs("gtfs-ace", 200);
  assert.ok(slow > fast, "the lettered feeds refresh less often, so they are polled less often");
  assert.ok(fast >= 1000 && fast <= 6000, `numbered-line cadence out of range: ${fast}ms`);
});
