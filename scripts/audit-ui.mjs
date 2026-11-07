/**
 * Interaction audit: drive the real UI through the paths a person takes, and record every
 * console error, unhandled rejection, failed request and broken assertion along the way.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const BIN = "/Users/oddurs/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const BASE = process.argv[2] ?? "http://localhost:7117";
const MOBILE = process.env.MOBILE === "1";
const port = 9000 + Math.floor(Math.random() * 900);
/* A throwaway browser profile, in a temp directory and deleted afterwards. These used to be
   written into the repository and left there: 721 MB of them, which is what filled the disk. */
const PROFILE = mkdtempSync(join(tmpdir(), "tt-audit-"));
process.on("exit", () => { try { rmSync(PROFILE, { recursive: true, force: true }); } catch {} });
const chrome = spawn(BIN, ["--headless=new","--no-sandbox","--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader",
  "--ignore-gpu-blocklist","--hide-scrollbars",`--window-size=${MOBILE?390:1500},${MOBILE?844:950}`,`--remote-debugging-port=${port}`,
  "--user-data-dir="+PROFILE,"--no-first-run","about:blank"],{stdio:["ignore","ignore","ignore"]});
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
let t; for(let i=0;i<60;i++){try{const l=await (await fetch(`http://127.0.0.1:${port}/json`)).json();t=l.find(x=>x.type==="page");if(t)break}catch{} await sleep(200)}
const ws=new WebSocket(t.webSocketDebuggerUrl); await new Promise(r=>ws.onopen=r);
let id=0; const pend=new Map(); const problems=[]; const reqUrl=new Map();
ws.onmessage=(e)=>{const m=JSON.parse(e.data);
  if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id);return}
  if(m.method==="Runtime.consoleAPICalled"&&["error","warning"].includes(m.params.type)){
    const txt=m.params.args.map(a=>a.value??a.description??"").join(" ");
    if(!/DevTools|HMR|Fast Refresh|GL Driver|wood-pattern|Download the React/.test(txt)) problems.push({kind:"console."+m.params.type,txt:txt.slice(0,240)});
  }
  if(m.method==="Runtime.exceptionThrown") problems.push({kind:"exception",txt:(m.params.exceptionDetails.exception?.description??m.params.exceptionDetails.text).slice(0,240)});
  if(m.method==="Log.entryAdded"&&m.params.entry.level==="error"){const txt=m.params.entry.text;
    if(!/favicon|GL Driver/.test(txt)) problems.push({kind:"log.error",txt:txt.slice(0,240)});}
  if(m.method==="Network.requestWillBeSent") reqUrl.set(m.params.requestId,m.params.request.url);
  if(m.method==="Network.loadingFailed"&&!/favicon/.test(m.params.errorText)){
    const url=reqUrl.get(m.params.requestId)??"";
    // An abort is a request somebody cancelled, not one that failed: this crawl navigates while
    // the alert feed and the state stream are still in flight, and both are meant to be dropped.
    // Every other network error is still a problem, and now says which URL it was.
    if(m.params.errorText!=="net::ERR_ABORTED")
      problems.push({kind:"netfail",txt:m.params.errorText+" "+(m.params.type??"")+" "+url.slice(0,120)});
  }
  if(m.method==="Network.responseReceived"&&m.params.response.status>=400&&!/favicon/.test(m.params.response.url)) problems.push({kind:"http"+m.params.response.status,txt:m.params.response.url.slice(0,140)});
};
const send=(method,params={})=>new Promise(r=>{const i=++id;pend.set(i,r);ws.send(JSON.stringify({id:i,method,params}))});
const evalJs=async(expr)=>{const r=await send("Runtime.evaluate",{expression:expr,returnByValue:true,awaitPromise:true});
  if(r.result?.exceptionDetails) return {error:r.result.exceptionDetails.exception?.description??"threw"};
  return {value:r.result?.result?.value}};
await send("Runtime.enable"); await send("Log.enable"); await send("Network.enable"); await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride",{width:MOBILE?390:1500,height:MOBILE?844:950,deviceScaleFactor:MOBILE?3:1,mobile:MOBILE});
if(MOBILE) await send("Emulation.setTouchEmulationEnabled",{enabled:true,maxTouchPoints:5});
if(process.env.GEO){const[lat,lon]=process.env.GEO.split(",").map(Number);
  await send("Browser.grantPermissions",{origin:new URL(BASE).origin,permissions:["geolocation"]});
  await send("Emulation.setGeolocationOverride",{latitude:lat,longitude:lon,accuracy:20});}

const steps=[];
const step=async(name,fn)=>{const before=problems.length; let note;
  try{ note=await fn(); }catch(e){ problems.push({kind:"step",txt:name+": "+e.message}); }
  steps.push({name,note,newProblems:problems.length-before});};

await send("Page.navigate",{url:BASE+"/"}); await sleep(14000);

await step("initial load", async()=>{ const r=await evalJs(`JSON.stringify({status:document.querySelector(".map-badge")?.innerText, map:!!document.querySelector(".maplibregl-canvas")})`); return r.value??r.error; });
await step("search + pick a station", async()=>{
  await evalJs(`(()=>{const i=document.querySelector(".field input");const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set;s.call(i,"Union Sq");i.dispatchEvent(new Event("input",{bubbles:true}));})()`);
  await sleep(900);
  const r=await evalJs(`(()=>{const b=document.querySelector(".popover li button"); if(!b) return "no results"; b.click(); return "clicked "+b.innerText.split("\\n")[0];})()`);
  await sleep(2500); return r.value??r.error;});
await step("board renders", async()=>{const r=await evalJs(`JSON.stringify({title:document.querySelector(".board h2")?.innerText, rows:document.querySelectorAll(".board-group .list .row").length, groups:document.querySelectorAll(".board-group").length})`); return r.value??r.error;});
await step("open a train from the board", async()=>{
  const r=await evalJs(`(()=>{const b=document.querySelector(".board-group .list .row"); if(!b) return "no rows"; b.click(); return "ok";})()`);
  await sleep(2500);
  const d=await evalJs(`JSON.stringify({detail:!!document.querySelector(".detail"), title:document.querySelector(".detail-title h2")?.innerText, stops:document.querySelectorAll(".detail .list .row").length, prov:document.querySelector(".detail .card .notice")?.innerText})`);
  return (r.value??r.error)+" | "+(d.value??d.error);});
await step("follow the train", async()=>{
  const r=await evalJs(`(()=>{const b=[...document.querySelectorAll(".detail .btn")].find(x=>/follow/i.test(x.innerText)); if(!b) return "no follow"; b.click(); return b.innerText;})()`);
  await sleep(2500); const s=await evalJs(`[...document.querySelectorAll(".detail .btn")].find(x=>/follow/i.test(x.innerText))?.innerText`); return (r.value??r.error)+" -> "+(s.value??s.error);});
await step("back gesture closes the train, then the station", async()=>{
  await evalJs(`history.back()`); await sleep(1500);
  const one=await evalJs(`JSON.stringify({board:!!document.querySelector(".board"), detail:!!document.querySelector(".detail")})`);
  await evalJs(`history.back()`); await sleep(1500);
  const two=await evalJs(`JSON.stringify({board:!!document.querySelector(".board"), detail:!!document.querySelector(".detail")})`);
  const ok=JSON.parse(one.value).board && !JSON.parse(one.value).detail && !JSON.parse(two.value).board;
  if(!ok) problems.push({kind:"assert",txt:"back did not step train → station → map: "+one.value+" then "+two.value});
  return one.value+" then "+two.value;});
await step("recent stations offered on focus", async()=>{
  const r=await evalJs(`(()=>{const i=document.querySelector(".field input"); i.focus(); i.dispatchEvent(new FocusEvent("focusin",{bubbles:true})); return new Promise(res=>setTimeout(()=>res([...document.querySelectorAll(".popover li")].map(l=>l.innerText.split("\\n")[0]).join(" / ")),600));})()`);
  await evalJs(`document.querySelector(".field input").blur()`);
  return r.value??r.error;});
await step("back to map", async()=>{const r=await evalJs(`(()=>{const b=document.querySelector(".detail .icon-btn:last-of-type"); if(b) b.click(); return "closed";})()`); await sleep(1500); return r.value??r.error;});
await step("open the lines group", async()=>{
  const r=await evalJs(`(()=>{const b=[...document.querySelectorAll(".row[aria-expanded]")].find(x=>/Lines on the map/.test(x.innerText)); if(!b) return "no lines row"; b.click(); return "opened";})()`);
  await sleep(800); const n=await evalJs(`document.querySelectorAll(".routes .roundel").length`); return (r.value??r.error)+" | "+(n.value??n.error)+" toggles";});
await step("toggle a route off and on", async()=>{
  await evalJs(`document.querySelectorAll(".routes .roundel")[0].click()`); await sleep(1200);
  const off=await evalJs(`JSON.stringify({hash:location.hash})`);
  await evalJs(`document.querySelectorAll(".routes .roundel")[0].click()`); await sleep(1200);
  const on=await evalJs(`JSON.stringify({hash:location.hash})`);
  return (off.value??"")+" then "+(on.value??"");});
await step("solo a route (shift-click)", async()=>{
  await evalJs(`document.querySelectorAll(".routes .roundel")[3].dispatchEvent(new MouseEvent("click",{bubbles:true,shiftKey:true}))`);
  await sleep(2500); const r=await evalJs(`JSON.stringify({hash:location.hash, laneMode:window.__tt?.laneMode})`); return r.value??r.error;});
await step("all / none", async()=>{
  await evalJs(`[...document.querySelectorAll(".panel .btn")].find(b=>b.innerText==="Hide all")?.click()`); await sleep(900);
  const none=await evalJs(`JSON.stringify({lines:[...document.querySelectorAll(".row[aria-expanded]")].find(x=>/Lines on the map/.test(x.innerText))?.innerText.replace(/\\n/g," · ")})`);
  await evalJs(`[...document.querySelectorAll(".panel .btn")].find(b=>b.innerText==="Show all")?.click()`); await sleep(900);
  return (none.value??"");});
await step("uncertainty toggle", async()=>{ await evalJs(`document.querySelector(".switch input")?.click()`); await sleep(800); await evalJs(`document.querySelector(".switch input")?.click()`); return "toggled";});
await step("history panel", async()=>{
  const r=await evalJs(`(()=>{const b=[...document.querySelectorAll(".sect-accessory .btn--ghost")].find(x=>/replay/i.test(x.innerText)); if(!b) return "no history button"; b.click(); return "opened";})()`);
  await sleep(4000);
  const d=await evalJs(`JSON.stringify({timeline:!!document.querySelector(".tl-bar"), bars:document.querySelectorAll(".tl-bar i").length, health:document.querySelectorAll(".health tbody tr").length})`);
  return (r.value??r.error)+" | "+(d.value??d.error);});
await step("save a station", async()=>{
  await evalJs(`(()=>{const i=document.querySelector(".field input");const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set;s.call(i,"Bedford Av");i.dispatchEvent(new Event("input",{bubbles:true}));})()`);
  await sleep(900); await evalJs(`document.querySelector(".popover li button")?.click()`); await sleep(2200);
  const r=await evalJs(`(()=>{const b=document.querySelector(".board-actions .icon-btn"); if(!b) return "no star"; b.click(); return "clicked";})()`);
  await sleep(1200);
  // Read the state after React has rendered it: the attribute does not change inside the click.
  const after=await evalJs(`document.querySelector(".board-actions .icon-btn")?.getAttribute("aria-pressed")`);
  return (r.value??r.error)+" -> aria-pressed="+(after.value??after.error);});
await step("destination / trip", async()=>{
  const open=await evalJs(`(()=>{const b=document.querySelector(".btn--tinted"); if(!b) return "no dest button"; b.click(); return "opened";})()`);
  await sleep(700);
  await evalJs(`(()=>{const i=document.querySelector(".field--bare input"); if(!i) return; const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set;s.call(i,"Lorimer");i.dispatchEvent(new Event("input",{bubbles:true}));})()`);
  await sleep(1000);
  await evalJs(`document.querySelector(".field--bare .popover li button")?.click()`); await sleep(2500);
  const r=await evalJs(`JSON.stringify({chip:document.querySelector(".dest-chip")?.innerText?.replace(/\\n/g," "), rows:[...document.querySelectorAll(".board-group .list .row")].slice(0,2).map(b=>b.innerText.replace(/\\n/g," · "))})`);
  return (open.value??"")+" | "+(r.value??r.error);});
await step("escape closes", async()=>{ await evalJs(`window.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape"}))`); await sleep(1000);
  const r=await evalJs(`JSON.stringify({board:!!document.querySelector(".board"), hash:location.hash})`); return r.value??r.error;});
await step("map click on empty space", async()=>{
  await send("Input.dispatchMouseEvent",{type:"mousePressed",x:1300,y:200,button:"left",clickCount:1});
  await send("Input.dispatchMouseEvent",{type:"mouseReleased",x:1300,y:200,button:"left",clickCount:1});
  await sleep(1200); const r=await evalJs(`JSON.stringify({board:!!document.querySelector(".board"),detail:!!document.querySelector(".detail")})`); return r.value??r.error;});
// The map handle is a development aid and is absent from production builds, so the layer-level
// checks below only run where it exists.
const hasHandle = (await evalJs(`typeof window.__tt !== "undefined" && !!window.__tt.map`)).value === true;
await step("deep zoom render", async()=>{ if(!hasHandle) return "skipped (no debug handle in a production build)";
  await evalJs(`__tt.map.jumpTo({center:[-73.9880,40.7580],zoom:16.5})`); await sleep(6000);
  const r=await evalJs(`JSON.stringify({trains:__tt.map.queryRenderedFeatures({layers:["trains"]}).length, lines:__tt.map.queryRenderedFeatures({layers:[0,1,2,3,4,5,6,7,8].map(z=>"routes-line-"+z)}).length})`); return r.value??r.error;});
await step("zoom out to whole system", async()=>{ if(!hasHandle) return "skipped (no debug handle in a production build)";
  await evalJs(`__tt.map.jumpTo({center:[-73.94,40.71],zoom:9.8})`); await sleep(5000);
  const r=await evalJs(`JSON.stringify({trains:__tt.map.queryRenderedFeatures({layers:["trains"]}).length})`); return r.value??r.error;});

console.log("=== STEPS ===");
for(const s of steps) console.log(`${s.newProblems>0?"!":" "} ${s.name.padEnd(28)} ${String(s.note??"").slice(0,190)}`);
console.log(`\n=== PROBLEMS (${problems.length}) ===`);
const seen=new Set();
for(const p of problems){const k=p.kind+"|"+p.txt.slice(0,90); if(seen.has(k))continue; seen.add(k); console.log(` [${p.kind}] ${p.txt}`);}
ws.close(); chrome.kill("SIGKILL");
