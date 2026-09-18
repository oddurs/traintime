/**
 * The selection ring follows its train, and costs nothing when it does not have to.
 *
 * The ring source is uploaded only when its contents change, which is what stopped it costing a
 * `setData` on every frame of every session. The failure that buys is a ring drawn once and then
 * frozen while its train moves out from under it — invisible in a screenshot, obvious in use, and
 * exactly the kind of thing a later simplification of the signature would reintroduce.
 *
 * So this asserts the invariant in both directions: when the train moves the ring moves with it and
 * uploads happen, and when the train is standing at a platform nothing is uploaded at all. It picks
 * the fastest train on the map rather than taking one on faith, because the branch worth testing is
 * the one where the train is moving, and a trip id read a minute ago is usually stopped by now.
 *
 *   npm run audit:ring          # needs the dev server, for its window.__tt handle
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { globSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

let TRIP = null;
const BASE = process.argv.find((a) => a.startsWith("http")) ?? "http://localhost:7117";
const W = 1200, H = 800;
const mac = globSync(join(homedir(), "Library/Caches/ms-playwright/chromium*/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"));
const BIN = process.env.CHROME_PATH ?? mac.sort().at(-1);
if (!BIN || !existsSync(BIN)) { console.log("no browser; skipping"); process.exit(0); }

const PROFILE = mkdtempSync(join(tmpdir(), "tt-ring-"));
process.on("exit", () => { try { rmSync(PROFILE, { recursive: true, force: true }); } catch {} });
const port = 9000 + Math.floor(Math.random() * 900);
const chrome = spawn(BIN, ["--headless=new", "--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader",
  "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--hide-scrollbars",
  `--window-size=${W},${H}`, `--remote-debugging-port=${port}`, "--user-data-dir=" + PROFILE,
  "--no-first-run", "about:blank"], { stdio: ["ignore", "ignore", "ignore"] });
process.on("exit", () => { try { chrome.kill(); } catch {} });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let t;
for (let i = 0; i < 80; i++) {
  try { const l = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); t = l.find((x) => x.type === "page"); if (t) break; } catch {}
  await sleep(200);
}
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;

await send("Runtime.enable");
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });

const settle = async () => {
  for (let i = 0; i < 90; i++) { if (await evalJs('document.querySelectorAll("canvas").length')) break; await sleep(400); }
  await sleep(12000);
};

await send("Page.navigate", { url: `${BASE}/?perf=1` });
await settle();
// The fastest train on the map right now, which is the one whose ring has the most to keep up with.
const fastest = await evalJs(`(() => {
  const ps = [...window.__tt.positionsRef.current.values()].filter(p => p.phase === "moving" && p.speed > 6);
  ps.sort((a, b) => b.speed - a.speed);
  return ps.length ? { id: ps[0].id, speed: ps[0].speed } : null;
})()`);
TRIP = fastest?.id ?? null;
if (!TRIP) { console.log("INCONCLUSIVE — no train was moving fast enough to test with."); process.exit(2); }
console.log(`picked           ${TRIP} at ${fastest.speed.toFixed(1)} m/s`);

/*
 * Follow it, which selects it and frames it.
 *
 * The extra query parameter is load-bearing. Navigating from `?perf=1` to `?perf=1#t=…` differs
 * only in the fragment, so the browser performs a same-document navigation, the app never
 * remounts, and `readHash()` never runs — the first version of this check did exactly that and
 * reported a missing ring that the app had never been asked to draw.
 */
await send("Page.navigate", { url: `${BASE}/?perf=1&run=2#t=${encodeURIComponent(TRIP)}` });
await settle();

// Read the ring source straight out of the map, which is the geometry MapLibre holds.
// `_data` is wrapped as { geojson: … } in this MapLibre; the first version of this check read
// `_data.features`, got undefined, and reported an empty ring that was in fact present.
const sample = () => evalJs(`(() => {
  const TRIP_ID = ${JSON.stringify(TRIP)};
  try {
    const m = window.__tt && window.__tt.map;
    if (!m) return { err: "no-map-handle" };
    const s = m.getSource("trains");
    const raw = s && s._data;
    const d = raw && (raw.features ? raw : raw.geojson);
    const f = d && d.features && d.features[0];
    const p = window.__tt.positionsRef.current.get(TRIP_ID);
    return {
      ring: f ? f.geometry.coordinates.map(n => n.toFixed(6)).join(",") : "empty",
      selected: f ? !!f.properties.selected : false,
      train: p ? [p.lon, p.lat].map(n => n.toFixed(6)).join(",") : "gone",
      speed: p ? p.speed : null,
    };
  } catch (e) { return { err: e.message }; }
})()`);

await evalJs("window.__ttPerf.reset()");
const a = await sample();
await sleep(10000);
const perf = await evalJs("window.__ttPerf.read()");
const b = await sample();

const uploads = perf.uploads.trains ?? 0;
console.log(`trip             ${TRIP}`);
console.log(`ring   t0        ${a.ring}   selected=${a.selected}`);
console.log(`ring   t+10s     ${b.ring}`);
console.log(`train  t0        ${a.train}   ${a.speed?.toFixed?.(1) ?? a.speed} m/s`);
console.log(`train  t+10s     ${b.train}   ${b.speed?.toFixed?.(1) ?? b.speed} m/s`);
console.log(`frames           ${perf.frames}`);
console.log(`trains uploads   ${uploads}  (${(uploads / Math.max(1, perf.frames)).toFixed(2)} per frame)`);
console.log("");
if (a.err || b.err) { console.log("INCONCLUSIVE —", a.err ?? b.err); process.exit(2); }

const present = a.ring !== "empty" && a.selected;
const trainMoved = a.train !== b.train;
// The invariant, which holds either way round: the ring follows the train when the train moves,
// and costs nothing when it does not.
const tracks = trainMoved ? (a.ring !== b.ring && uploads > 0) : (a.ring === b.ring);
console.log(`ring present and selected   ${present ? "yes" : "NO"}`);
console.log(`train moved over the window ${trainMoved ? "yes" : "no (standing at a platform)"}`);
console.log(`ring followed it            ${trainMoved ? (a.ring !== b.ring ? "yes" : "NO") : "n/a — nothing to follow"}`);
console.log("");
console.log(present && tracks
  ? trainMoved
    ? "PASS — the ring is present and tracked its train, and uploads happened only while it moved."
    : "PASS — the ring is present; the train stood still, so it correctly cost no uploads."
  : `FAIL — present=${present} tracks=${tracks}`);
process.exit(present && tracks ? 0 : 1);
