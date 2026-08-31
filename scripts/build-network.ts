/**
 * Preprocess the MTA static GTFS feed into a compact network file the client can load.
 *
 * Output: public/data/network.json
 *   routes        - id, name, color
 *   stations      - parent stations with lat/lon
 *   segments      - track geometry between each pair of consecutively-served stations,
 *                   keyed by canonical (sorted) station pair, sliced from shapes.txt
 *   prevOf        - per route: for each directional stop id, which stops precede it
 *   routeSegments - per route: which segment keys make up the line (for drawing)
 *   stationRoutes - per parent station: which routes serve it
 *
 * Usage: npx tsx scripts/build-network.ts [--zip path/to/gtfs_subway.zip]
 */
import AdmZip from "adm-zip";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const GTFS_URL = "https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip";
const ROOT = join(import.meta.dirname, "..");
const CACHE = join(ROOT, ".cache");
const OUT = join(ROOT, "public", "data", "network.json");

type LonLat = [number, number];

// --- CSV --------------------------------------------------------------------

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function* rows(text: string): Generator<Record<string, string>> {
  let start = 0;
  let header: string[] | null = null;
  while (start < text.length) {
    let end = text.indexOf("\n", start);
    if (end === -1) end = text.length;
    let line = text.slice(start, end);
    start = end + 1;
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (!line) continue;
    const cells = parseCsvLine(line);
    if (!header) { header = cells.map((h) => h.replace(/^﻿/, "")); continue; }
    const rec: Record<string, string> = {};
    for (let i = 0; i < header.length; i++) rec[header[i]] = cells[i] ?? "";
    yield rec;
  }
}

// --- Geometry ---------------------------------------------------------------

const KM_PER_DEG_LAT = 111.32;
function toXY([lon, lat]: LonLat, cosLat: number): [number, number] {
  return [lon * KM_PER_DEG_LAT * cosLat, lat * KM_PER_DEG_LAT];
}

/** Project point p onto polyline (as XY). Returns {dist, cum, segIdx, frac} using only segments >= fromIdx. */
function projectOnto(
  poly: [number, number][],
  cum: number[],
  p: [number, number],
  fromIdx: number,
  minCum: number,
) {
  let best = { dist: Infinity, cum: 0, segIdx: fromIdx, frac: 0 };
  for (let i = Math.max(0, fromIdx); i < poly.length - 1; i++) {
    const [ax, ay] = poly[i];
    const [bx, by] = poly[i + 1];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 === 0 ? 0 : ((p[0] - ax) * dx + (p[1] - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const c = cum[i] + t * Math.sqrt(len2);
    if (c < minCum) continue;
    const px = ax + t * dx, py = ay + t * dy;
    const d = Math.hypot(p[0] - px, p[1] - py);
    if (d < best.dist) best = { dist: d, cum: c, segIdx: i, frac: t };
  }
  return best;
}

function lerp(a: LonLat, b: LonLat, t: number): LonLat {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

function round(p: LonLat): LonLat {
  return [Math.round(p[0] * 1e5) / 1e5, Math.round(p[1] * 1e5) / 1e5];
}

// --- Main -------------------------------------------------------------------

async function main() {
  const zipArg = process.argv.indexOf("--zip");
  const zipPath = zipArg !== -1 ? process.argv[zipArg + 1] : join(CACHE, "gtfs_subway.zip");
  if (!existsSync(zipPath)) {
    console.log(`Downloading ${GTFS_URL} ...`);
    const res = await fetch(GTFS_URL);
    if (!res.ok) throw new Error(`GTFS download failed: ${res.status}`);
    mkdirSync(CACHE, { recursive: true });
    writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));
  } else {
    console.log(`Using cached ${zipPath}`);
  }

  const zip = new AdmZip(zipPath);
  const read = (name: string) => {
    const e = zip.getEntry(name);
    if (!e) throw new Error(`missing ${name} in zip`);
    return e.getData().toString("utf8");
  };

  // feed_info
  let feedVersion = "";
  for (const r of rows(read("feed_info.txt"))) feedVersion = r.feed_version ?? "";

  // routes
  const routes: Record<string, { id: string; name: string; color: string; textColor: string; sortOrder: number }> = {};
  for (const r of rows(read("routes.txt"))) {
    routes[r.route_id] = {
      id: r.route_id,
      name: r.route_long_name,
      color: "#" + (r.route_color || "808183"),
      textColor: "#" + (r.route_text_color || "FFFFFF"),
      sortOrder: Number(r.route_sort_order || 999),
    };
  }

  // stops -> parent stations
  const stations: Record<string, { id: string; name: string; lat: number; lon: number }> = {};
  const parentOf: Record<string, string> = {};
  for (const r of rows(read("stops.txt"))) {
    if (r.location_type === "1" || !r.parent_station) {
      stations[r.stop_id] = { id: r.stop_id, name: r.stop_name, lat: Number(r.stop_lat), lon: Number(r.stop_lon) };
    } else {
      parentOf[r.stop_id] = r.parent_station;
    }
  }
  const parent = (id: string) => parentOf[id] ?? id.replace(/[NS]$/, "");

  // shapes
  const shapePts: Record<string, { seq: number; p: LonLat }[]> = {};
  for (const r of rows(read("shapes.txt"))) {
    (shapePts[r.shape_id] ??= []).push({ seq: Number(r.shape_pt_sequence), p: [Number(r.shape_pt_lon), Number(r.shape_pt_lat)] });
  }
  const shapes: Record<string, LonLat[]> = {};
  for (const [id, pts] of Object.entries(shapePts)) {
    pts.sort((a, b) => a.seq - b.seq);
    shapes[id] = pts.map((x) => x.p);
  }

  // trips: one representative trip per (route, shape)
  const repTrip: Record<string, { route: string; shape: string }> = {};
  const seenShape = new Set<string>();
  for (const r of rows(read("trips.txt"))) {
    const key = `${r.route_id}|${r.shape_id}`;
    if (seenShape.has(key) || !r.shape_id) continue;
    seenShape.add(key);
    repTrip[r.trip_id] = { route: r.route_id, shape: r.shape_id };
  }
  console.log(`${Object.keys(repTrip).length} representative trips across ${Object.keys(shapes).length} shapes`);

  // stop_times for representative trips only
  const tripStops: Record<string, { seq: number; stop: string; dep: number; arr: number }[]> = {};
  const hms = (t: string) => { const [h, m, s] = t.split(":").map(Number); return h * 3600 + m * 60 + (s || 0); };
  for (const r of rows(read("stop_times.txt"))) {
    if (!(r.trip_id in repTrip)) continue;
    (tripStops[r.trip_id] ??= []).push({ seq: Number(r.stop_sequence), stop: r.stop_id, arr: hms(r.arrival_time), dep: hms(r.departure_time) });
  }

  // Build segments
  const segments: Record<string, LonLat[]> = {};
  const prevOf: Record<string, Record<string, Set<string>>> = {};
  const routeSegments: Record<string, Set<string>> = {};
  const stationRoutes: Record<string, Set<string>> = {};
  const schedRunSum: Record<string, { sum: number; n: number }> = {};
  let straightFallbacks = 0;

  for (const [tripId, { route, shape }] of Object.entries(repTrip)) {
    const stops = tripStops[tripId];
    const poly = shapes[shape];
    if (!stops || !poly || poly.length < 2) continue;
    stops.sort((a, b) => a.seq - b.seq);

    const cosLat = Math.cos((poly[0][1] * Math.PI) / 180);
    const xy = poly.map((p) => toXY(p, cosLat));
    const cum: number[] = [0];
    for (let i = 1; i < xy.length; i++) cum.push(cum[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]));

    // project each stop
    const proj: { stop: string; cum: number; segIdx: number; frac: number; ok: boolean }[] = [];
    let fromIdx = 0, minCum = 0;
    for (const s of stops) {
      const st = stations[parent(s.stop)];
      if (!st) { proj.push({ stop: s.stop, cum: minCum, segIdx: fromIdx, frac: 0, ok: false }); continue; }
      const r = projectOnto(xy, cum, toXY([st.lon, st.lat], cosLat), fromIdx, minCum);
      const ok = r.dist < 0.3; // within 300 m of the track
      proj.push({ stop: s.stop, cum: r.cum, segIdx: r.segIdx, frac: r.frac, ok });
      if (ok) { fromIdx = r.segIdx; minCum = r.cum; }
    }

    routeSegments[route] ??= new Set();
    prevOf[route] ??= {};
    for (const st of stops) (stationRoutes[parent(st.stop)] ??= new Set()).add(route);
    for (let i = 1; i < proj.length; i++) {
      const a = proj[i - 1], b = proj[i];
      const pa = parent(a.stop), pb = parent(b.stop);
      if (pa === pb) continue;
      (prevOf[route][b.stop] ??= new Set()).add(a.stop);

      const forward = pa < pb;
      const key = forward ? `${pa}-${pb}` : `${pb}-${pa}`;
      routeSegments[route].add(key);
      const run = stops[i].arr - stops[i - 1].dep;
      if (run > 0 && run < 1800) {
        const acc = (schedRunSum[key] ??= { sum: 0, n: 0 });
        acc.sum += run; acc.n++;
      }
      if (segments[key]) continue;

      let line: LonLat[];
      if (a.ok && b.ok && b.cum > a.cum) {
        line = [lerp(poly[a.segIdx], poly[a.segIdx + 1], a.frac)];
        for (let k = a.segIdx + 1; k <= b.segIdx; k++) line.push(poly[k]);
        line.push(lerp(poly[b.segIdx], poly[b.segIdx + 1], b.frac));
      } else {
        straightFallbacks++;
        const sa = stations[pa], sb = stations[pb];
        line = [[sa.lon, sa.lat], [sb.lon, sb.lat]];
      }
      // dedupe consecutive duplicates, round
      const cleaned: LonLat[] = [];
      for (const p of line.map(round)) {
        const last = cleaned[cleaned.length - 1];
        if (!last || last[0] !== p[0] || last[1] !== p[1]) cleaned.push(p);
      }
      if (cleaned.length < 2) { const sa = stations[pa], sb = stations[pb]; cleaned.splice(0, cleaned.length, round([sa.lon, sa.lat]), round([sb.lon, sb.lat])); }
      segments[key] = forward ? cleaned : cleaned.reverse();
    }
  }

  const out = {
    generatedAt: new Date().toISOString(),
    feedVersion,
    routes,
    stations,
    segments,
    prevOf: Object.fromEntries(
      Object.entries(prevOf).map(([r, m]) => [r, Object.fromEntries(Object.entries(m).map(([k, v]) => [k, [...v]]))]),
    ),
    routeSegments: Object.fromEntries(Object.entries(routeSegments).map(([r, s]) => [r, [...s]])),
    schedRun: Object.fromEntries(Object.entries(schedRunSum).map(([k, v]) => [k, Math.round(v.sum / v.n)])),
    stationRoutes: Object.fromEntries(
      Object.entries(stationRoutes).map(([k, v]) => [
        k,
        [...v].sort((a, b) => (routes[a]?.sortOrder ?? 999) - (routes[b]?.sortOrder ?? 999)),
      ]),
    ),
  };
  mkdirSync(join(ROOT, "public", "data"), { recursive: true });
  writeFileSync(OUT, JSON.stringify(out));
  const kb = Math.round(readFileSync(OUT).length / 1024);
  console.log(
    `Wrote ${OUT} (${kb} KB): ${Object.keys(routes).length} routes, ${Object.keys(stations).length} stations, ` +
      `${Object.keys(segments).length} segments (${straightFallbacks} straight-line fallbacks)`,
  );
}

main().catch((e) => { console.error(e); process.exit(1); });
