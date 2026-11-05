/**
 * What the app costs someone on a phone, on a platform, on a bad connection.
 *
 * Everything up to now was measured on localhost, where a 936 KB chunk is free. Usage:
 *   node scripts/audit-weight.mjs [url] [--profile slow-4g|fast-3g|none]
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createReadStream, mkdtempSync, rmSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { existsSync, globSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const PROFILES = {
  "slow-4g": { downloadThroughput: (400 * 1024) / 8, uploadThroughput: (400 * 1024) / 8, latency: 400 },
  "fast-3g": { downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8, latency: 150 },
  none: { downloadThroughput: -1, uploadThroughput: -1, latency: 0 },
};
const args = process.argv.slice(2);
const BASE = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--root" && args[i - 1] !== "--profile") ?? "http://localhost:7117";
const profile = (args.includes("--profile") ? args[args.indexOf("--profile") + 1] : "slow-4g");
const net = PROFILES[profile] ?? PROFILES["slow-4g"];

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const guesses = [
    "/Users/oddurs/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium",
  ];
  for (const g of guesses) if (existsSync(g)) return g;
  return globSync(join(homedir(), ".cache/ms-playwright/chromium*/chrome-linux/chrome"))[0] ?? null;
}
const BIN = findChrome();
if (!BIN) { console.log("weight — no browser available; skipping"); process.exit(0); }

/**
 * Serve the built site the way a real host does — with compression.
 *
 * Without it the numbers are meaningless: network.json is 444 KB raw and 100 KB gzipped, so an
 * uncompressed local server reports a load four times slower than anything a person would see,
 * and every conclusion drawn from it is wrong.
 */
let stop = () => {};
/**
 * Everything the local server sent, whoever asked: the page, its service worker, or the map's
 * worker. Requests from a worker are not on the page's network log, so this is the only complete
 * count of what a first visit downloads from the site.
 */
const served = [];
let target = BASE;
if (args.includes("--serve")) {
  // --root serves another build, so two builds can be measured side by side on the same machine.
  const root = join(process.cwd(), args.includes("--root") ? args[args.indexOf("--root") + 1] : "out");
  const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json", ".proto": "text/plain" };
  const srv = createServer((req, res) => {
    let p = decodeURIComponent((req.url ?? "/").split("?")[0]).replace(/^\/traintime/, "");
    let file = join(root, p);
    try { if (statSync(file).isDirectory()) file = join(file, "index.html"); } catch { file = join(root, p + ".html"); }
    let body;
    try { body = readFileSync(file); } catch { res.writeHead(404); return res.end(); }
    const ext = file.slice(file.lastIndexOf("."));
    const compress = /\.(html|m?js|css|json|svg|webmanifest|proto)$/.test(file);
    const out = compress ? gzipSync(body) : body;
    // The real site server's rule, so a request the browser can answer from cache is answered there.
    const immutable = /\/_next\/static\/|\/maplibre\/\d/.test(file);
    res.writeHead(200, { "content-type": types[ext] ?? "application/octet-stream", ...(compress ? { "content-encoding": "gzip" } : {}), "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-store" });
    served.push({ path: p, bytes: out.length });
    res.end(out);
  });
  await new Promise((r) => srv.listen(0, r));
  target = `http://127.0.0.1:${srv.address().port}/traintime`;
  stop = () => srv.close();
  void createReadStream;
}

const port = 9000 + Math.floor(Math.random() * 900);
/* A throwaway browser profile, in a temp directory and deleted afterwards. These used to be
   written into the repository and left there: 721 MB of them, which is what filled the disk. */
const PROFILE = mkdtempSync(join(tmpdir(), "tt-audit-"));
process.on("exit", () => { try { rmSync(PROFILE, { recursive: true, force: true }); } catch {} });
const chrome = spawn(BIN, ["--headless=new","--no-sandbox","--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader",
  "--hide-scrollbars","--window-size=390,844",`--remote-debugging-port=${port}`,
  "--user-data-dir="+PROFILE,"--no-first-run","about:blank"],{stdio:["ignore","ignore","ignore"]});
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
let t; for(let i=0;i<60;i++){try{const l=await (await fetch(`http://127.0.0.1:${port}/json`)).json();t=l.find(x=>x.type==="page");if(t)break}catch{} await sleep(200)}
const ws=new WebSocket(t.webSocketDebuggerUrl); await new Promise(r=>ws.onopen=r);
let id=0; const pend=new Map(); const bytes=new Map(); let firstPaint=0, started=0;
const urls=new Map(); const finished=[]; const asked=new Map();
ws.onmessage=(e)=>{const m=JSON.parse(e.data);
  if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id);return}
  if(m.method==="Network.requestWillBeSent") { urls.set(m.params.requestId, m.params.request.url); asked.set(m.params.requestId, Date.now()-started); }
  if(m.method==="Network.loadingFinished"){ bytes.set(m.params.requestId,(bytes.get(m.params.requestId)??0)+m.params.encodedDataLength);
    finished.push({ url: urls.get(m.params.requestId)??"", kb: m.params.encodedDataLength/1024, at: Date.now()-started, from: asked.get(m.params.requestId) ?? 0 }); }
  if(m.method==="Page.lifecycleEvent"&&m.params.name==="firstContentfulPaint"&&!firstPaint) firstPaint=Date.now()-started;
};
const send=(m,p={})=>new Promise(r=>{const i=++id;pend.set(i,r);ws.send(JSON.stringify({id:i,method:m,params:p}))});
const js=(e)=>send("Runtime.evaluate",{expression:e,returnByValue:true,awaitPromise:true}).then(r=>r.result?.result?.value);
await send("Network.enable"); await send("Page.enable"); await send("Runtime.enable");
await send("Page.setLifecycleEventsEnabled",{enabled:true});
// Cold, not cacheless: a first visit starts with an empty cache, and then uses it. Disabling it made
// the map's worker download the module the page had fetched a second earlier, which no browser does.
await send("Network.clearBrowserCache");
await send("Network.emulateNetworkConditions",{offline:false,...net});
// A response the service worker answers reaches the page as 0 bytes, and the worker's own fetch is
// not on the page's network log at all: the default run undercounts every chunk on a first visit.
// --no-sw sends everything to the network, so every byte the map waits for is on the bill.
if (args.includes("--no-sw")) await send("Network.setBypassServiceWorker", { bypass: true });
await send("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:3,mobile:true});
await send("Emulation.setCPUThrottlingRate",{rate:4});

started = Date.now();
await send("Page.navigate",{url:`${target}/?v=${Date.now()}`});
// Time until something a rider can read is on screen.
let readable = 0;
for (let i = 0; i < 400; i++) {
  const ok = await js(`!!document.querySelector('.list .row, .board, .field input')`);
  if (ok) { readable = Date.now() - started; break; }
  await sleep(100);
}
// When nothing readable turned up, say what was actually on screen rather than only that it
// wasn't: a slow network and a broken selector look identical from the outside.
const onScreen = readable ? "" : await js(`JSON.stringify({panel:!!document.querySelector('.panel'), field:!!document.querySelector('.field'), booting:!!document.querySelector('.booting'), text:(document.body.innerText||'').slice(0,120)})`);
// When does the map itself appear? It is deliberately held back so the board wins the link, and
// how long that costs is worth knowing rather than assuming.
let mapAt = 0;
for (let i = 0; i < 400; i++) {
  if (await js(`!!document.querySelector('canvas.maplibregl-canvas')`)) { mapAt = Date.now() - started; break; }
  await sleep(100);
}
// A canvas element exists long before there is a map in it: the style, and the worker's own
// download, come after. `tt:map` is set when the style has loaded, the moment real visits report.
let readyAt = 0;
for (let i = 0; i < 400 && mapAt; i++) {
  const t = await js(`(performance.getEntriesByName('tt:map')[0] || {}).startTime || 0`);
  if (t) { readyAt = Math.round(t); break; }
  await sleep(100);
}
await sleep(2500);
const total = [...bytes.values()].reduce((a, b) => a + b, 0);
ws.close(); chrome.kill("SIGKILL"); stop();

const kb = (n) => `${Math.round(n / 1024)} KB`;
console.log(`weight — ${profile}, 4x CPU throttle, cold cache, iPhone-sized viewport`);
console.log(`  first contentful paint      ${firstPaint ? firstPaint + " ms" : "not seen"}`);
console.log(`  something readable on screen ${readable ? readable + " ms" : "not within 40 s — " + onScreen}`);
console.log(`  transferred                 ${kb(total)} over ${bytes.size} requests${args.includes("--no-sw") ? "" : " (not counting what the service worker fetched; --no-sw to)"}`);
console.log(`  map canvas on screen        ${mapAt ? mapAt + " ms" : "not within 40 s"}`);
console.log(`  map ready (style loaded)    ${readyAt ? readyAt + " ms" : "not seen"}`);
if (args.includes("--serve")) console.log(`  served from the site         ${kb(served.reduce((a, f) => a + f.bytes, 0))} in ${served.length} responses, counting workers`);
if (args.includes("--waterfall") && args.includes("--serve")) {
  const byPath = new Map();
  for (const f of served) byPath.set(f.path, [(byPath.get(f.path)?.[0] ?? 0) + 1, (byPath.get(f.path)?.[1] ?? 0) + f.bytes]);
  console.log("\n  served more than once:");
  for (const [path, [n, b]] of byPath) if (n > 1) console.log(`    ${n}×  ${kb(b)}  ${path}`);
}
if (args.includes("--waterfall")) {
  console.log("\n  every request, by when it was asked for:");
  for (const f of [...finished].sort((a, b) => a.from - b.from))
    console.log(`    ${String(Math.round(f.from)).padStart(6)} → ${String(Math.round(f.at)).padStart(6)} ms  ${String(Math.round(f.kb)).padStart(4)} KB  ${f.url.replace(/^https?:\/\/[^/]+/, "").slice(0, 60)}`);
}
console.log("\n  what arrived before the page was readable:");
for (const f of finished.filter((f) => f.at <= readable + 50).sort((a, b) => b.kb - a.kb).slice(0, 8))
  console.log(`    ${String(Math.round(f.kb)).padStart(5)} KB  at ${String(Math.round(f.at)).padStart(6)} ms  ${f.url.split("/").pop().slice(0, 46)}`);
// The map is the slowest thing on screen, and what it waited for is mostly not what the page did.
if (mapAt) {
  console.log("\n  what arrived after that and before the map was ready:");
  for (const f of finished.filter((f) => f.at > readable + 50 && f.at <= Math.max(mapAt, readyAt) + 50).sort((a, b) => b.kb - a.kb).slice(0, 10))
    console.log(`    ${String(Math.round(f.kb)).padStart(5)} KB  at ${String(Math.round(f.at)).padStart(6)} ms  ${f.url.split("/").pop().slice(0, 46)}`);
}
