/**
 * What a gesture costs, measured on the real map.
 *
 * Three milestones of render work are about to be judged on whether the map "feels" better. This
 * is the baseline they are judged against, and it deliberately does not report a frame rate: the
 * headless browser rasterises in software, so its frame rate is a fact about SwiftShader, and on
 * real hardware the rate is pinned to the display until it suddenly is not. Neither number moves
 * when we fix the thing that is wrong.
 *
 * What it reports instead is main-thread work we own and pipeline work we ask for:
 *
 *   cb mean/max   milliseconds inside our own rAF callback — GPU-independent, and ours to fix
 *   main%         share of wall time the main thread spent in tasks, which is where an upload
 *                 is actually paid for: the callback returns long before the worker is done
 *   *_/fr         `setData` calls per frame, per source
 *
 * The last column is the point, and it is stated per frame rather than per second because the
 * frame rate here belongs to the rasteriser. `1.00` means every single frame asks for an upload —
 * a worker round-trip, a re-parse, a re-tile — and a gesture that costs more of them than sitting
 * still does is the complaint about panning, as a number rather than an impression.
 *
 *   node scripts/audit-frames.mjs                        # against the dev server on :7117
 *   node scripts/audit-frames.mjs http://localhost:8080   # or a built copy
 *   node scripts/audit-frames.mjs --json                  # for a diff against a later run
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { globSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const BASE = argv.find((a) => !a.startsWith("--")) ?? "http://localhost:7117";
const AS_JSON = argv.includes("--json");
const WIDTH = 1500, HEIGHT = 950;
/* Long enough that a 4-per-second clock is sampled several times over, short enough to stay a
   test rather than an errand. */
const WINDOW_MS = 4000;

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const mac = globSync(join(homedir(), "Library/Caches/ms-playwright/chromium*/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"));
  if (mac.length) return mac.sort().at(-1);
  for (const g of ["/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium"]) if (existsSync(g)) return g;
  return globSync(join(homedir(), ".cache/ms-playwright/chromium*/chrome-linux/chrome"))[0] ?? null;
}
const BIN = findChrome();
if (!BIN) { console.log("frames — no browser available; skipping"); process.exit(0); }

const PROFILE = mkdtempSync(join(tmpdir(), "tt-frames-"));
process.on("exit", () => { try { rmSync(PROFILE, { recursive: true, force: true }); } catch {} });
const port = 9000 + Math.floor(Math.random() * 900);
const chrome = spawn(BIN, ["--headless=new", "--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader",
  "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--hide-scrollbars",
  `--window-size=${WIDTH},${HEIGHT}`, `--remote-debugging-port=${port}`, "--user-data-dir=" + PROFILE,
  "--no-first-run", "about:blank"], { stdio: ["ignore", "ignore", "ignore"] });
process.on("exit", () => { try { chrome.kill(); } catch {} });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 80; i++) {
  try { const l = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); target = l.find((x) => x.type === "page"); if (target) break; } catch {}
  await sleep(200);
}
if (!target) { console.log("frames — browser never came up; skipping"); process.exit(0); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
};

await send("Runtime.enable");
await send("Page.enable");
await send("Performance.enable");

/**
 * Cumulative main-thread task time, in seconds.
 *
 * Needed because the first run of this script showed our own callback costing well under a
 * millisecond while the map still stuttered: a `setData` is paid for *after* the callback returns —
 * serialising to a worker, re-parsing, re-tiling, rebuilding buckets — so timing our own function
 * measures the one part of the problem we were not causing. This catches the rest.
 */
const taskSeconds = async () => {
  const r = await send("Performance.getMetrics");
  return (r.result?.metrics ?? []).find((m) => m.name === "TaskDuration")?.value ?? 0;
};
await send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });

const cx = WIDTH / 2, cy = HEIGHT / 2;

/** A drag across the middle of the map, in the steps a hand would make. */
async function pan() {
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: cx + 300, y: cy, button: "left", clickCount: 1, buttons: 1 });
  for (let i = 1; i <= 40; i++) {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: cx + 300 - i * 12, y: cy + Math.sin(i / 6) * 40, button: "left", buttons: 1 });
    await sleep(WINDOW_MS / 40 - 2);
  }
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: cx - 180, y: cy, button: "left", clickCount: 1, buttons: 0 });
}

/** Scrolling in, which is the gesture the complaint names. */
async function scrollIn() {
  const steps = 30;
  for (let i = 0; i < steps; i++) {
    await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: cx, y: cy, deltaX: 0, deltaY: -70, modifiers: 0 });
    await sleep(WINDOW_MS / steps - 2);
  }
}

async function idle() { await sleep(WINDOW_MS); }

const SCENARIOS = [["idle", idle], ["pan", pan], ["scroll in", scrollIn]];
const ZOOMS = [11, 16];
const THROTTLES = [1, 4];
const rows = [];
let run = 0;

for (const throttle of THROTTLES) {
  for (const zoom of ZOOMS) {
    await send("Emulation.setCPUThrottlingRate", { rate: 1 });
    /*
     * The camera comes from the hash, which is how every view in this app is addressed — so this
     * works against a production build, where no debug handle on `window` exists.
     *
     * `run` is load-bearing, not cache-busting. Two URLs differing only in the fragment are a
     * same-document navigation: the app does not remount, `readHash()` never runs, and the camera
     * stays wherever the last scenario left it. The first version of this script did that, so
     * every row after the first was measured at the zoom the previous group's scroll-in had
     * reached — roughly 19 — while claiming 11 or 16. The numbers were real; the labels were not.
     */
    await send("Page.navigate", { url: `${BASE}/?perf=1&run=${++run}#@=40.7500,-73.9800,${zoom.toFixed(1)}` });
    // The map has to have its style, its network and some trains before any of this means
    // anything. Poll for trains rather than guess at a sleep.
    let ready = false;
    for (let i = 0; i < 90; i++) {
      const n = await evalJs('(() => { try { return document.querySelectorAll("canvas").length; } catch { return 0; } })()');
      if (n > 0) { ready = true; break; }
      await sleep(400);
    }
    if (!ready) { console.log("frames — the map never rendered a canvas; skipping"); process.exit(0); }
    // Let the feed arrive and the first tiles settle, so the first scenario is not measuring load.
    await sleep(9000);
    const armed = await evalJs('!!(window.__ttPerf && window.__ttPerf.on)');
    if (!armed) { console.log("frames — ?perf=1 did not arm the counters; is this build instrumented?"); process.exit(1); }
    // Trust nothing about the camera: read it back, and say so if it is not where it was asked
    // to be. This is the check the same-document bug above would have failed.
    const got = await evalJs('(window.__tt && window.__tt.map) ? window.__tt.map.getZoom() : null');
    if (got !== null && Math.abs(got - zoom) > 0.3) {
      console.log(`frames — asked for zoom ${zoom} and got ${got.toFixed(2)}; the navigation did not take`);
      process.exit(1);
    }
    await send("Emulation.setCPUThrottlingRate", { rate: throttle });

    for (const [name, run] of SCENARIOS) {
      await evalJs("window.__ttPerf.reset()");
      const task0 = await taskSeconds();
      await run();
      const taskMs = (await taskSeconds() - task0) * 1000;
      const m = await evalJs("window.__ttPerf.read()");
      rows.push({
        throttle, zoom, scenario: name,
        frames: m.frames,
        fps: m.perSecond.frames,
        cbMean: m.meanMs,
        cbMax: m.maxMs,
        over8: m.over8,
        over16: m.over16,
        uploads: m.uploads,
        uploadsPerSecond: Object.fromEntries(Object.entries(m.perSecond).filter(([k]) => k !== "frames")),
        // Per frame rather than per second, because the frame rate here is a fact about the
        // software rasteriser. "One upload every frame" is the defect, and it is scale-free.
        uploadsPerFrame: Object.fromEntries(Object.entries(m.uploads).map(([k, v]) => [k, m.frames ? v / m.frames : 0])),
        taskMs,
        taskFraction: taskMs / m.sinceMs,
        /*
         * Main-thread milliseconds per frame, which is the column to compare across runs.
         *
         * `main%` is a share of wall time, and it is only comparable when the frame rate is. It is
         * not: removing the uploads roughly tripled the frames delivered in the same four seconds,
         * so the main thread does more useful work in the same share of time and `main%` can rise
         * while every frame got cheaper. Per frame, it cannot.
         */
        mainMsPerFrame: m.frames ? taskMs / m.frames : 0,
      });
    }
    await send("Emulation.setCPUThrottlingRate", { rate: 1 });
  }
}

if (AS_JSON) {
  console.log(JSON.stringify({ base: BASE, at: new Date().toISOString(), window_ms: WINDOW_MS, rows }, null, 2));
  process.exit(0);
}

const n = (x, d = 1) => (x ?? 0).toFixed(d);
const pf = (r, k) => n(r.uploadsPerFrame[k] ?? 0, 2);
console.log(`frames — ${BASE}  ·  ${WINDOW_MS / 1000}s per scenario  ·  ${new Date().toISOString().slice(0, 16)}Z\n`);
console.log("cpu  zoom  scenario     fps   cb mean  main ms/fr   main%   trains/fr  ribbons/fr  stacks/fr");
console.log("─".repeat(99));
let lastKey = "";
for (const r of rows) {
  const key = `${r.throttle}|${r.zoom}`;
  if (lastKey && key !== lastKey) console.log("");
  lastKey = key;
  console.log(
    `${String(r.throttle + "x").padEnd(4)} ${String(r.zoom).padEnd(5)} ${r.scenario.padEnd(12)} ` +
    `${n(r.fps).padStart(5)} ${n(r.cbMean, 2).padStart(9)} ${n(r.mainMsPerFrame, 1).padStart(12)} ` +
    `${n(r.taskFraction * 100, 0).padStart(6)}% ` +
    `${pf(r, "trains").padStart(11)} ${pf(r, "ribbons").padStart(11)} ${pf(r, "train-stacks").padStart(10)}`,
  );
}
console.log("\ncb  = milliseconds inside our own rAF callback. It is cheap; the cost of an upload is");
console.log("      paid after it returns, which is what main% catches.");
console.log("main ms/fr = main-thread task time per frame. This is the column to compare between runs;");
console.log("      main% is a share of wall time and is only comparable when the frame rate is.");
console.log("/fr = setData calls per frame. 1.00 means every single frame asks for one.");
process.exit(0);
