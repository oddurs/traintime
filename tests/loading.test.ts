import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { loadPhase, loadingHint } from "../src/lib/loading";
import { HOME, posterTransform, project } from "../src/lib/home";
import { FIRST_PAINT_SCRIPT, PLACES_KEY, SAVED_HEIGHT_KEY } from "../src/lib/firstPaint";

test("an open stream with no trains yet is connecting, not live with zero trains", () => {
  // es.onopen sets connected and clears the error before the first snapshot; that is not data.
  assert.equal(loadPhase(true, { error: undefined, messages: 0 }), "connecting");
  assert.equal(loadingHint("connecting", { failed: false, slow: false }), "connecting to live trains…");
  assert.equal(loadPhase(true, { error: undefined, messages: 1 }), "ready");
  assert.equal(loadingHint("ready", { failed: false, slow: false }), null);
});

test("a dropped stream is a fault to report, not a load in progress", () => {
  assert.equal(loadPhase(true, { error: "reconnecting…", messages: 0 }), "ready");
});

test("stations that failed to load say so instead of loading forever", () => {
  assert.equal(loadPhase(false, { error: undefined, messages: 5 }), "stations");
  assert.equal(loadingHint("stations", { failed: true, slow: true }), "stations not loaded");
  assert.equal(loadingHint("stations", { failed: false, slow: true }), "still loading — the connection is slow");
});

test("the poster sits untransformed at home, follows a nearby view, and stands down far from it", () => {
  assert.equal(posterTransform(undefined), "");
  assert.equal(posterTransform({ ...HOME }), "translate(0.0px, 0.0px) scale(1.0000)");
  // A view centred east of home sees home to its west: the poster moves left.
  const east = posterTransform({ lon: HOME.lon + 0.01, lat: HOME.lat, zoom: HOME.zoom })!;
  const dx = project(HOME.lon, HOME.lat, HOME.zoom)[0] - project(HOME.lon + 0.01, HOME.lat, HOME.zoom)[0];
  assert.ok(dx < 0 && east.startsWith(`translate(${dx.toFixed(1)}px`), east);
  assert.equal(posterTransform({ ...HOME, zoom: HOME.zoom + 1.5 }), null);
});

/** Runs the head script against a fake browser, the way it runs before React. */
function firstPaint(store: Record<string, string>, phone = false) {
  const classes = new Set<string>();
  const props = new Map<string, string>();
  const document = { documentElement: { classList: { add: (c: string) => classes.add(c) }, style: { setProperty: (k: string, v: string) => props.set(k, v) } } };
  const localStorage = { getItem: (k: string) => store[k] ?? null };
  runInNewContext(FIRST_PAINT_SCRIPT, { document, localStorage, matchMedia: () => ({ matches: phone }), JSON });
  return { classes, props };
}

test("the first paint holds the saved list's last height, for the layout it is drawn in", () => {
  const store = { [PLACES_KEY]: JSON.stringify([{ id: "127", name: "Times Sq" }]), [SAVED_HEIGHT_KEY]: JSON.stringify({ phone: 96, wide: 120 }) };
  assert.equal(firstPaint(store, true).props.get("--saved-h"), "96px");
  assert.equal(firstPaint(store, false).props.get("--saved-h"), "120px");
  // No places, nothing held, whatever height was remembered.
  assert.ok(!firstPaint({ ...store, [PLACES_KEY]: "[]" }).classes.has("has-saved"));
});

test("the first paint survives storage that throws", () => {
  const document = { documentElement: { classList: { add() {} }, style: { setProperty() {} } } };
  const localStorage = { getItem() { throw new Error("SecurityError"); } };
  assert.doesNotThrow(() => runInNewContext(FIRST_PAINT_SCRIPT, { document, localStorage, matchMedia: () => ({ matches: false }), JSON }));
});
