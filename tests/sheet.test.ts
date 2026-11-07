/** Where the swipe-up card goes when a finger lets go of it. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { snapStop, FLICK_V } from "../src/lib/sheet";

/** A 390 × 844 phone: the collapsed card is its head, then half and nearly all of the screen. */
const H = { peek: 80, half: 422, full: 776 };

test("a slow drag settles on the stop nearest where it was let go", () => {
  assert.equal(snapStop(H, 200, 0), "peek");
  assert.equal(snapStop(H, 300, 0), "half");
  assert.equal(snapStop(H, 640, 0), "full");
});

test("a drag still drifting when it is let go settles where it was heading", () => {
  // 230 points tall is nearer the collapsed card, but it was still rising at 0.3 pt/ms.
  assert.equal(snapStop(H, 230, 0), "peek");
  assert.equal(snapStop(H, 230, -0.3), "half");
});

test("a flick goes one stop in its direction, however short it was", () => {
  assert.equal(snapStop(H, 110, -FLICK_V), "half");
  assert.equal(snapStop(H, 440, -1.5), "full");
  assert.equal(snapStop(H, 410, 1.5), "peek");
  assert.equal(snapStop(H, 760, 0.8), "half");
});

test("a flick past the last stop stays at it", () => {
  assert.equal(snapStop(H, 790, -2), "full");
  assert.equal(snapStop(H, 70, 2), "peek");
});
