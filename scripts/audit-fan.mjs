/**
 * How far a train can be from its own line, in pixels, during a gesture.
 *
 * The fan — the sideways shift that makes five services sharing Queens Boulevard read as five
 * lines — is a function of zoom. The line gets it from the renderer, evaluated with the camera the
 * frame is actually drawn with. Before render-2 the train got it from the frame callback, evaluated
 * with `map.getZoom()` read before MapLibre had integrated that camera. Same formula, different
 * argument, and the difference is a lateral error that opens through every gesture and closes
 * afterwards.
 *
 * This measures the difference between those two arguments without needing to read anything back
 * off the GPU: record the zoom a `requestAnimationFrame` callback sees and the zoom the following
 * `render` sees, pair them, and evaluate the real `fanAt` at both. That is exactly the error the old
 * code committed, in pixels, and it is zero by construction once the fan is computed in the shader
 * from the frame's own camera.
 *
 *   npm run audit:fan
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { globSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fanAt } from "../src/lib/layout.ts";

const BASE = process.argv.find((a) => a.startsWith("http")) ?? "http://localhost:7117";
/*
 * CPU throttle. A smooth easeTo at full speed is the friendliest case for the old code: the frame
 * callback and the render that follows it see almost the same camera. Under throttling the gap
 * between them is where a stale reading would open up, so the honest number is the throttled one.
 */
const THROTTLE = Number(process.argv.find((a) => a.startsWith("--cpu="))?.slice(6) ?? 1);
/** A band two tracks out, which is what a local on a four-track trunk rides. */
const CB = 0, MB = 2;
const W = 1400, H = 900;

const mac = globSync(join(homedir(), "Library/Caches/ms-playwright/chromium*/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"));
const BIN = process.env.CHROME_PATH ?? mac.sort().at(-1);
if (!BIN || !existsSync(BIN)) { console.log("fan — no browser available; skipping"); process.exit(0); }

const PROFILE = mkdtempSync(join(tmpdir(), "tt-fan-"));
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
if (!t) { console.log("fan — browser never came up; skipping"); process.exit(0); }
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;

await send("Runtime.enable");
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: `${BASE}/?perf=1#@=40.7480,-73.8900,14.4` });
for (let i = 0; i < 120; i++) { if (await evalJs('document.querySelectorAll("canvas").length')) break; await sleep(400); }
await sleep(12000);
if (!(await evalJs("!!(window.__tt && window.__tt.map)"))) {
  console.log("fan — no window.__tt handle; run this against the dev server");
  process.exit(2);
}
if (THROTTLE !== 1) await send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });

/*
 * Record both readings through one zoom animation.
 *
 * The rAF sample is what the frame callback would place the trains with; the render sample is the
 * camera the line is drawn with. Sampling is passive — nothing here changes what the map does.
 */
const samples = await evalJs(`(async () => {
  const m = window.__tt.map;
  const raf = [], ren = [];
  let running = true;
  const onRaf = () => { if (!running) return; raf.push([performance.now(), m.getZoom()]); requestAnimationFrame(onRaf); };
  const onRender = () => { if (running) ren.push([performance.now(), m.getZoom()]); };
  requestAnimationFrame(onRaf);
  m.on("render", onRender);
  m.easeTo({ zoom: 17.2, duration: 3500 });
  await new Promise((r) => setTimeout(r, 4200));
  running = false;
  m.off("render", onRender);
  return { raf, ren };
})()`);

if (!samples || !samples.ren?.length) { console.log("fan — no samples captured"); process.exit(1); }

/** The fan offset, in pixels, for one band at one zoom. */
const off = (z) => { const f = fanAt(z); return CB * f.colour + MB * f.metric; };

/*
 * Pair each drawn frame with the rAF reading that preceded it, which is the one the old code would
 * have used for that frame, and take the difference in pixels.
 */
let i = 0;
const errs = [];
for (const [ts, zr] of samples.ren) {
  while (i + 1 < samples.raf.length && samples.raf[i + 1][0] <= ts) i++;
  const prior = samples.raf[i];
  if (!prior) continue;
  const dz = zr - prior[1];
  errs.push({ dz: Math.abs(dz), px: Math.abs(off(zr) - off(prior[1])) });
}
if (!errs.length) { console.log("fan — could not pair any frames"); process.exit(1); }

const px = errs.map((e) => e.px).sort((a, b) => a - b);
const dz = errs.map((e) => e.dz).sort((a, b) => a - b);
const q = (a, p) => a[Math.min(a.length - 1, Math.floor(p * a.length))];
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;

console.log(`fan — ${BASE}  ·  zoom 14.4 -> 17.2 over 3.5 s  ·  band (cb ${CB}, mb ${MB})  ·  cpu ${THROTTLE}x\n`);
console.log(`frames drawn            ${samples.ren.length}`);
console.log(`rAF samples             ${samples.raf.length}`);
console.log(`paired                  ${errs.length}\n`);
console.log("zoom seen by the frame callback vs by the frame actually drawn:");
console.log(`  mean |dz|             ${mean(dz).toFixed(4)}`);
console.log(`  p95 |dz|              ${q(dz, 0.95).toFixed(4)}`);
console.log(`  max |dz|              ${dz[dz.length - 1].toFixed(4)}\n`);
console.log("lateral error that difference would put between a train and its line:");
console.log(`  mean                  ${mean(px).toFixed(2)} px`);
console.log(`  p95                   ${q(px, 0.95).toFixed(2)} px`);
console.log(`  max                   ${px[px.length - 1].toFixed(2)} px\n`);
console.log("This is the error the CPU fan committed. The shader fan reads the camera inside");
console.log("render(), so for the trains it is zero by construction — there is one reading.");
process.exit(0);
