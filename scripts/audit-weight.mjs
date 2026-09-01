/**
 * What the app costs someone on a phone, on a platform, on a bad connection.
 *
 * Everything up to now was measured on localhost, where a 936 KB chunk is free. Usage:
 *   node scripts/audit-weight.mjs [url] [--profile slow-4g|fast-3g|none]
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createReadStream, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { existsSync, globSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PROFILES = {
  "slow-4g": { downloadThroughput: (400 * 1024) / 8, uploadThroughput: (400 * 1024) / 8, latency: 400 },
  "fast-3g": { downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8, latency: 150 },
  none: { downloadThroughput: -1, uploadThroughput: -1, latency: 0 },
};
const args = process.argv.slice(2);
const BASE = args.find((a) => !a.startsWith("--")) ?? "http://localhost:7117";
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
let target = BASE;
if (args.includes("--serve")) {
  const root = join(process.cwd(), "out");
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json", ".proto": "text/plain" };
  const srv = createServer((req, res) => {
    let p = decodeURIComponent((req.url ?? "/").split("?")[0]).replace(/^\/traintime/, "");
    let file = join(root, p);
    try { if (statSync(file).isDirectory()) file = join(file, "index.html"); } catch { file = join(root, p + ".html"); }
    let body;
    try { body = readFileSync(file); } catch { res.writeHead(404); return res.end(); }
    const ext = file.slice(file.lastIndexOf("."));
    const compress = /\.(html|js|css|json|svg|webmanifest|proto)$/.test(file);
    const out = compress ? gzipSync(body) : body;
    res.writeHead(200, { "content-type": types[ext] ?? "application/octet-stream", ...(compress ? { "content-encoding": "gzip" } : {}), "cache-control": "no-store" });
    res.end(out);
  });
  await new Promise((r) => srv.listen(0, r));
  target = `http://127.0.0.1:${srv.address().port}/traintime`;
  stop = () => srv.close();
  void createReadStream;
}

const port = 9000 + Math.floor(Math.random() * 900);
const chrome = spawn(BIN, ["--headless=new","--no-sandbox","--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader",
  "--hide-scrollbars","--window-size=390,844",`--remote-debugging-port=${port}`,
  "--user-data-dir="+process.cwd()+"/audit-profile/w"+Date.now(),"--no-first-run","about:blank"],{stdio:["ignore","ignore","ignore"]});
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
let t; for(let i=0;i<60;i++){try{const l=await (await fetch(`http://127.0.0.1:${port}/json`)).json();t=l.find(x=>x.type==="page");if(t)break}catch{} await sleep(200)}
const ws=new WebSocket(t.webSocketDebuggerUrl); await new Promise(r=>ws.onopen=r);
let id=0; const pend=new Map(); const bytes=new Map(); let firstPaint=0, started=0;
const urls=new Map(); const finished=[];
ws.onmessage=(e)=>{const m=JSON.parse(e.data);
  if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id);return}
  if(m.method==="Network.requestWillBeSent") urls.set(m.params.requestId, m.params.request.url);
  if(m.method==="Network.loadingFinished"){ bytes.set(m.params.requestId,(bytes.get(m.params.requestId)??0)+m.params.encodedDataLength);
    finished.push({ url: urls.get(m.params.requestId)??"", kb: m.params.encodedDataLength/1024, at: Date.now()-started }); }
  if(m.method==="Page.lifecycleEvent"&&m.params.name==="firstContentfulPaint"&&!firstPaint) firstPaint=Date.now()-started;
};
const send=(m,p={})=>new Promise(r=>{const i=++id;pend.set(i,r);ws.send(JSON.stringify({id:i,method:m,params:p}))});
const js=(e)=>send("Runtime.evaluate",{expression:e,returnByValue:true,awaitPromise:true}).then(r=>r.result?.result?.value);
await send("Network.enable"); await send("Page.enable"); await send("Runtime.enable");
await send("Page.setLifecycleEventsEnabled",{enabled:true});
await send("Network.clearBrowserCache"); await send("Network.setCacheDisabled",{cacheDisabled:true});
await send("Network.emulateNetworkConditions",{offline:false,...net});
await send("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:3,mobile:true});
await send("Emulation.setCPUThrottlingRate",{rate:4});

started = Date.now();
await send("Page.navigate",{url:`${target}/?v=${Date.now()}`});
// Time until something a rider can read is on screen.
let readable = 0;
for (let i = 0; i < 400; i++) {
  const ok = await js(`!!document.querySelector('.arrivals button, .board, .search input')`);
  if (ok) { readable = Date.now() - started; break; }
  await sleep(100);
}
// When does the map itself appear? It is deliberately held back so the board wins the link, and
// how long that costs is worth knowing rather than assuming.
let mapAt = 0;
for (let i = 0; i < 400; i++) {
  if (await js(`!!document.querySelector('canvas.maplibregl-canvas')`)) { mapAt = Date.now() - started; break; }
  await sleep(100);
}
await sleep(2500);
const total = [...bytes.values()].reduce((a, b) => a + b, 0);
ws.close(); chrome.kill("SIGKILL"); stop();

const kb = (n) => `${Math.round(n / 1024)} KB`;
console.log(`weight — ${profile}, 4x CPU throttle, cold cache, iPhone-sized viewport`);
console.log(`  first contentful paint      ${firstPaint ? firstPaint + " ms" : "not seen"}`);
console.log(`  something readable on screen ${readable ? readable + " ms" : "not within 40 s"}`);
console.log(`  transferred                 ${kb(total)} over ${bytes.size} requests`);
console.log(`  map canvas on screen        ${mapAt ? mapAt + " ms" : "not within 40 s"}`);
console.log("\n  what arrived before the page was readable:");
for (const f of finished.filter((f) => f.at <= readable + 50).sort((a, b) => b.kb - a.kb).slice(0, 8))
  console.log(`    ${String(Math.round(f.kb)).padStart(5)} KB  at ${String(Math.round(f.at)).padStart(6)} ms  ${f.url.split("/").pop().slice(0, 46)}`);
