/**
 * The change advice. This is the one thing traintime can say that a countdown clock cannot, and
 * it is also the one thing that is actively harmful to get wrong: telling someone to get off a
 * train costs them the train.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NetworkIndex } from "../src/lib/network";
import { betterConnection } from "../src/lib/connection";
import type { Network, TrainState, StopPrediction } from "../src/lib/types";

const net = JSON.parse(readFileSync(join(process.cwd(), "public/data/network.json"), "utf8")) as Network;
const idx = new NetworkIndex(net);
const NOW = 1_788_000_000;

/** Three stations the 1 calls at in order, so the fixtures sit on real geography. */
const line = net.shapeStops[Object.keys(net.shapeStops).find((k) => k.startsWith("1.."))!];
const [A, B, C] = [line[2], line[5], line[9]];

const train = (id: string, route: string, stops: [string, number][]): TrainState => ({
  id, route, direction: "S", assigned: true, phase: "moving",
  prevStop: A, nextStop: stops[0][0], eta: stops[0][1], etaRaw: stops[0][1], sigma: 20,
  updatedAt: NOW,
  stops: stops.map(([sid, eta]): StopPrediction => ({ id: sid, eta, etaRaw: eta, sigma: 20 })),
} as unknown as TrainState);

test("it names the change when a faster train can actually be caught", () => {
  const mine = train("local", "1", [[A, NOW + 60], [B, NOW + 300], [C, NOW + 900]]);
  const express = train("express", "2", [[B, NOW + 400], [C, NOW + 600]]);
  const c = betterConnection(idx, [mine, express], mine, C, NOW);
  assert.ok(c, "a five-minute saving with a workable change should be offered");
  assert.equal(c!.toRoute, "2");
  assert.equal(c!.saving, 300);
  assert.ok(c!.atName.length > 0, "a rider needs somewhere to get off, by name");
});

test("it stays quiet when the change cannot be made in time", () => {
  const mine = train("local", "1", [[B, NOW + 300], [C, NOW + 900]]);
  // The express calls at B before we get there, so crossing to it is not possible.
  const express = train("express", "2", [[B, NOW + 310], [C, NOW + 600]]);
  assert.equal(betterConnection(idx, [mine, express], mine, C, NOW), undefined);
});

test("it stays quiet about savings too small to act on", () => {
  const mine = train("local", "1", [[B, NOW + 300], [C, NOW + 900]]);
  const other = train("other", "2", [[B, NOW + 400], [C, NOW + 840]]);
  assert.equal(betterConnection(idx, [mine, other], mine, C, NOW), undefined, "a minute is not advice");
});

test("it stays quiet when the other train never reaches where you are going", () => {
  const mine = train("local", "1", [[B, NOW + 300], [C, NOW + 900]]);
  const elsewhere = train("elsewhere", "2", [[B, NOW + 400]]);
  assert.equal(betterConnection(idx, [mine, elsewhere], mine, C, NOW), undefined);
});

test("it does not send you to another train on the line you are already on", () => {
  const mine = train("local", "1", [[B, NOW + 300], [C, NOW + 900]]);
  const sameRoute = train("ahead", "1", [[B, NOW + 400], [C, NOW + 600]]);
  assert.equal(betterConnection(idx, [mine, sameRoute], mine, C, NOW), undefined);
});

test("a stale or unstarted train is never offered as a connection", () => {
  const mine = train("local", "1", [[B, NOW + 300], [C, NOW + 900]]);
  const ghost = { ...train("ghost", "2", [[B, NOW + 400], [C, NOW + 600]]), stale: true } as TrainState;
  assert.equal(betterConnection(idx, [mine, ghost], mine, C, NOW), undefined);
});
