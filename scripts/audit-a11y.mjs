/**
 * Accessibility audit: drive the real page and check the things a transit app gets wrong.
 *
 * The one that matters most here is the live region. The entire content of this application is a
 * number that changes every second; without one, a screen reader announces the board when it
 * opens and then never mentions it again.
 *
 * Usage: node scripts/audit-a11y.mjs [http://localhost:7117]
 */
import { spawn } from "node:child_process";
import { existsSync, globSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
/** Wherever Chrome happens to live: a developer's machine, or a CI runner. */
function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const guesses = [
    "/Users/oddurs/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  for (const g of guesses) if (existsSync(g)) return g;
  const found = globSync(join(homedir(), ".cache/ms-playwright/chromium*/chrome-linux/chrome"));
  return found[0] ?? null;
}
const BIN = findChrome();
if (!BIN) { console.log("accessibility — no browser available; skipping"); process.exit(0); }
const BASE = process.argv[2] ?? "http://localhost:7117";
const port = 9000 + Math.floor(Math.random() * 900);
const chrome = spawn(BIN, ["--headless=new","--no-sandbox","--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader",
  "--hide-scrollbars","--window-size=1400,900",`--remote-debugging-port=${port}`,
  "--user-data-dir="+process.cwd()+"/audit-profile/a11y"+Date.now(),"--no-first-run","about:blank"],{stdio:["ignore","ignore","ignore"]});
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
let t; for(let i=0;i<60;i++){try{const l=await (await fetch(`http://127.0.0.1:${port}/json`)).json();t=l.find(x=>x.type==="page");if(t)break}catch{} await sleep(200)}
const ws=new WebSocket(t.webSocketDebuggerUrl); await new Promise(r=>ws.onopen=r);
let id=0; const pend=new Map();
ws.onmessage=(e)=>{const m=JSON.parse(e.data); if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id);}};
const send=(m,p={})=>new Promise(r=>{const i=++id;pend.set(i,r);ws.send(JSON.stringify({id:i,method:m,params:p}))});
const js=(e)=>send("Runtime.evaluate",{expression:e,returnByValue:true,awaitPromise:true}).then(r=>r.result?.result?.value);
await send("Runtime.enable"); await send("Page.enable");
await send("Page.navigate",{url:`${BASE}/?v=${Date.now()}`});
await sleep(9000);
// Open a board, because that is where the live content is.
await js(`(()=>{const i=document.querySelector('.field input'); if(!i) return;
  const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
  s.call(i,'Union Sq'); i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
await sleep(2200);
await js(`(()=>{const b=document.querySelector('.popover li button'); if(b) b.click();})()`);
await sleep(3000);

const report = await js(`(()=>{
  // An element's accessible name, the way a screen reader would work it out.
  const named = (el) => {
    if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('title')) return true;
    if (el.closest('label')) return true;
    if (el.id && document.querySelector('label[for="'+CSS.escape(el.id)+'"]')) return true;
    return !!(el.innerText || '').trim();
  };
  const inter = [...document.querySelectorAll('button,a[href],input,select,textarea,[role="button"]')];
  const heads = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')];
  const levels = heads.map(h => +h.tagName[1]);
  const skips = [];
  for (let i = 1; i < levels.length; i++) if (levels[i] - levels[i-1] > 1) skips.push(heads[i-1].tagName + ' -> ' + heads[i].tagName + ' (' + (heads[i].innerText||'').trim().slice(0,30) + ')');
  const live = [...document.querySelectorAll('[aria-live]')];
  return JSON.stringify({
    lang: document.documentElement.lang || '',
    title: (document.title||'').trim(),
    unnamed: inter.filter(el => !named(el)).map(el => (el.className||el.tagName).toString().slice(0,40)),
    headingSkips: skips,
    liveRegions: live.length,
    liveText: live.map(el => (el.textContent||'').trim().slice(0,80)),
    landmarks: document.querySelectorAll('main,nav,aside,header,footer,[role="main"]').length,
    imagesWithoutAlt: [...document.querySelectorAll('img')].filter(i=>!i.hasAttribute('alt')).length,
  });})()`);
ws.close(); chrome.kill("SIGKILL");

const r = JSON.parse(report);
const problems = [];
if (!r.lang) problems.push("the document does not declare a language");
if (!r.title) problems.push("the document has no title");
for (const u of r.unnamed) problems.push(`an interactive element has no accessible name: ${u}`);
for (const s of r.headingSkips) problems.push(`headings skip a level: ${s}`);
if (r.liveRegions === 0) problems.push("no live region: a changing countdown is announced once and never again");
if (r.liveRegions > 0 && !r.liveText.some((t) => t.length > 0)) problems.push("the live region is empty");
if (r.landmarks === 0) problems.push("no landmarks to navigate by");
if (r.imagesWithoutAlt) problems.push(`${r.imagesWithoutAlt} image(s) without alt text`);

console.log(`accessibility — ${r.landmarks} landmarks, ${r.liveRegions} live region(s), ${r.headingSkips.length} heading skips`);
if (r.liveText[0]) console.log(`  announces: "${r.liveText[0]}"`);
if (!problems.length) { console.log("\nPASS — nothing found\n"); process.exit(0); }
console.log(`\n=== PROBLEMS (${problems.length}) ===`);
for (const p of problems) console.log(" " + p);
process.exit(1);
