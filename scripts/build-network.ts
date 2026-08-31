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
 *   complexes     - stations a rider thinks of as one place, from transfers.txt
 *   segmentSlots  - per segment, the lane each route occupies among the services sharing that
 *                   corridor, so parallel lines can be fanned out on the map
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

/**
 * Chaikin corner cutting. The GTFS shapes turn a few degrees at half their vertices, which reads
 * as a jagged line once the track is drawn thick and offset into lanes; cutting corners twice
 * turns those kinks into curves. Endpoints are pinned so a segment still starts and ends at its
 * stations.
 */
function chaikin(line: LonLat[], iterations = 2): LonLat[] {
  let out = line;
  for (let it = 0; it < iterations; it++) {
    if (out.length < 3) return out;
    const next: LonLat[] = [out[0]];
    for (let i = 0; i + 1 < out.length; i++) {
      const a = out[i], b = out[i + 1];
      next.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
      next.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    next.push(out[out.length - 1]);
    out = next;
  }
  return out;
}

/** Douglas-Peucker, with the tolerance in metres, to undo the point explosion on straight runs. */
function simplify(line: LonLat[], toleranceM = 1.5): LonLat[] {
  if (line.length < 3) return line;
  const cosLat = Math.cos((line[0][1] * Math.PI) / 180);
  const xy = line.map((p) => [p[0] * 111_320 * cosLat, p[1] * 111_320] as [number, number]);
  const keep = new Uint8Array(line.length);
  keep[0] = keep[line.length - 1] = 1;
  const stack: [number, number][] = [[0, line.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop()!;
    if (hi - lo < 2) continue;
    const [ax, ay] = xy[lo], [bx, by] = xy[hi];
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    let far = -1, best = toleranceM;
    for (let i = lo + 1; i < hi; i++) {
      const d = Math.abs((xy[i][0] - ax) * dy - (xy[i][1] - ay) * dx) / len;
      if (d > best) { best = d; far = i; }
    }
    if (far > 0) { keep[far] = 1; stack.push([lo, far], [far, hi]); }
  }
  return line.filter((_, i) => keep[i]);
}

function lerp(a: LonLat, b: LonLat, t: number): LonLat {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

function round(p: LonLat): LonLat {
  // 6 decimals is ~0.1 m: fine enough that corner smoothing is not quantised back into kinks.
  return [Math.round(p[0] * 1e6) / 1e6, Math.round(p[1] * 1e6) / 1e6];
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

  // Station complexes. A rider says "Times Sq", but GTFS has five stations there — one per
  // trunk — linked only by transfers.txt. Union them so a board answers the question actually
  // being asked.
  const parentOfComplex = new Map<string, string>();
  const find = (x: string): string => {
    const p = parentOfComplex.get(x);
    if (p === undefined || p === x) return x;
    const root = find(p);
    parentOfComplex.set(x, root);
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parentOfComplex.set(ra, rb);
  };
  for (const r of rows(read("transfers.txt"))) {
    if (r.from_stop_id && r.to_stop_id && r.from_stop_id !== r.to_stop_id) union(r.from_stop_id, r.to_stop_id);
  }

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
      const smoothed = simplify(chaikin(cleaned, 4), 0.3).map(round);
      segments[key] = forward ? smoothed : smoothed.reverse();
    }
  }

  // --- Corridors -------------------------------------------------------------
  // Two services "share track" when their geometry runs alongside, which is not the same as
  // sharing a station pair: on Lexington Avenue the 4 and 5 run express over three of the 6's
  // segments, so they never share a key. Detect it from the geometry instead — sample every
  // line into a coarse grid, remembering the direction of travel through each cell, and treat
  // routes as neighbours only where they pass through the same cell going the same way (which
  // keeps perpendicular crossings from being mistaken for shared track).
  const routeSegmentList: Record<string, string[]> = Object.fromEntries(
    Object.entries(routeSegments).map(([r, set]) => [r, [...set]]),
  );
  const CELL_M = 35;
  const STEP_M = 18;
  const cellKey = (lon: number, lat: number) => {
    const y = Math.round((lat * 111_320) / CELL_M);
    const x = Math.round((lon * 111_320 * Math.cos((lat * Math.PI) / 180)) / CELL_M);
    return `${x}:${y}`;
  };
  const bearingOf = (a: LonLat, b: LonLat) => {
    const cos = Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
    return (Math.atan2((b[0] - a[0]) * cos, b[1] - a[1]) * 180) / Math.PI;
  };
  /** Walk a polyline emitting a point roughly every STEP_M metres, with the local bearing. */
  function* walk(line: LonLat[]): Generator<{ p: LonLat; bearing: number }> {
    for (let i = 0; i + 1 < line.length; i++) {
      const a = line[i], b = line[i + 1];
      const cos = Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
      const dx = (b[0] - a[0]) * 111_320 * cos, dy = (b[1] - a[1]) * 111_320;
      const len = Math.hypot(dx, dy);
      const bearing = bearingOf(a, b);
      const steps = Math.max(1, Math.round(len / STEP_M));
      for (let k = 0; k < steps; k++) {
        const t = k / steps;
        yield { p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], bearing };
      }
    }
    if (line.length) yield { p: line[line.length - 1], bearing: line.length > 1 ? bearingOf(line[line.length - 2], line[line.length - 1]) : 0 };
  }
  /** Angle between two undirected line directions, 0..90. */
  const align = (a: number, b: number) => {
    let d = Math.abs(a - b) % 180;
    if (d > 90) d = 180 - d;
    return d;
  };

  const cellRoutes = new Map<string, { route: string; bearing: number }[]>();
  for (const [route, keys] of Object.entries(routeSegmentList)) {
    for (const key of keys) {
      const line = segments[key];
      if (!line) continue;
      for (const { p, bearing } of walk(line)) {
        const k = cellKey(p[0], p[1]);
        const list = cellRoutes.get(k) ?? cellRoutes.set(k, []).get(k)!;
        if (!list.some((e) => e.route === route && align(e.bearing, bearing) < 20)) list.push({ route, bearing });
      }
    }
  }

  // The realtime trip id carries its shape ("129200_3..N01R" -> "3..N01R"), and a shape has an
  // exact ordered stop list. That is a far better answer to "where did this train come from"
  // than any inference over the route graph.
  const shapeStops: Record<string, string[]> = {};
  for (const [tripId, { shape }] of Object.entries(repTrip)) {
    const stops = tripStops[tripId];
    if (!stops || !shape) continue;
    shapeStops[shape] = [...stops].sort((a, b) => a.seq - b.seq).map((x) => x.stop);
  }

  const routeSegments_ = new Map<string, string[]>();
  for (const [route, keys] of Object.entries(routeSegmentList)) {
    for (const key of keys) (routeSegments_.get(key) ?? routeSegments_.set(key, []).get(key)!).push(route);
  }

  const segmentSlots: Record<string, Record<string, [number, number]>> = {};
  const trackSlots: Record<string, Record<string, [number, number]>> = {};
  const order = (r: string) => routes[r]?.sortOrder ?? 999;
  for (const [key, line] of Object.entries(segments)) {
    const own = [...(routeSegments_.get(key) ?? [])];
    if (own.length === 0) continue;
    const seen = new Map<string, number>();
    let samples = 0;
    for (const { p, bearing } of walk(line)) {
      samples++;
      const y = Math.round((p[1] * 111_320) / CELL_M);
      const x = Math.round((p[0] * 111_320 * Math.cos((p[1] * Math.PI) / 180)) / CELL_M);
      const near = new Set<string>();
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (const e of cellRoutes.get(`${x + dx}:${y + dy}`) ?? []) {
            if (align(e.bearing, bearing) < 25) near.add(e.route);
          }
        }
      }
      for (const r of near) seen.set(r, (seen.get(r) ?? 0) + 1);
    }
    // A route shares this corridor if it runs alongside for most of the segment.
    const corridor = [...seen.entries()].filter(([r, n]) => n >= samples * 0.6 || own.includes(r)).map(([r]) => r);
    corridor.sort((a, b) => order(a) - order(b));
    // Services sharing a trunk share a colour by design (the 4, 5 and 6 are all Lexington green),
    // so lanes are assigned per colour: one green trunk here, but red beside green where the
    // Eastern Parkway lines run together. Routes in the same colour group get the same lane.
    const lanes: string[] = [];
    for (const r of corridor) {
      const c = routes[r]?.color ?? r;
      if (!lanes.includes(c)) lanes.push(c);
    }
    const n = lanes.length;
    const slots: Record<string, [number, number]> = {};
    const tracks: Record<string, [number, number]> = {};
    for (const r of own) {
      const i = lanes.indexOf(routes[r]?.color ?? r);
      slots[r] = [i < 0 ? 0 : i - (n - 1) / 2, n];
      // Within a colour, each service still runs on its own track: the 4 and 5 use Lexington's
      // express pair while the 6 uses the local. Trains ride these; the drawn line does not.
      const sameColour = corridor.filter((x) => (routes[x]?.color ?? x) === (routes[r]?.color ?? r));
      const j = sameColour.indexOf(r);
      tracks[r] = [j < 0 ? 0 : j - (sameColour.length - 1) / 2, sameColour.length];
    }
    segmentSlots[key] = slots;
    trackSlots[key] = tracks;
  }
  // Group the stations, and name each complex after whichever of its stations serves the most
  // routes — that is the name on the street.
  const groups = new Map<string, string[]>();
  for (const id of Object.keys(stations)) {
    const root = find(id);
    (groups.get(root) ?? groups.set(root, []).get(root)!).push(id);
  }
  const complexOf: Record<string, string> = {};
  const complexes: Record<string, { name: string; stations: string[]; routes: string[] }> = {};
  for (const ids of groups.values()) {
    const best = [...ids].sort((a, b) => {
      const ra = (stationRoutes[a]?.size ?? 0), rb = (stationRoutes[b]?.size ?? 0);
      if (ra !== rb) return rb - ra;
      return (stations[a]?.name.length ?? 99) - (stations[b]?.name.length ?? 99);
    })[0];
    const routeSet = new Set<string>();
    for (const id of ids) for (const r of stationRoutes[id] ?? []) routeSet.add(r);
    const key = best;
    complexes[key] = {
      name: stations[best]?.name ?? best,
      stations: ids,
      routes: [...routeSet].sort((a, b) => (routes[a]?.sortOrder ?? 999) - (routes[b]?.sortOrder ?? 999)),
    };
    for (const id of ids) complexOf[id] = key;
  }
  const multi = Object.values(complexes).filter((c) => c.stations.length > 1);
  console.log(`complexes: ${Object.keys(complexes).length} (${multi.length} spanning more than one station, largest ${Math.max(...Object.values(complexes).map((c) => c.stations.length))})`);

  const shared = Object.values(segmentSlots).filter((s) => Object.values(s).some(([, n]) => n > 1)).length;
  console.log(`corridors: ${shared} of ${Object.keys(segmentSlots).length} segments share track`);

  // --- Continuous runs --------------------------------------------------------
  // Drawing one disconnected feature per segment leaves a hard butt end wherever a lane changes,
  // which is what makes a converging line look like it was cut off. Instead, chain each route's
  // segments into the longest runs that keep the same lane, so a line is one continuous stroke
  // from where it joins a corridor to where it leaves. Runs are stored as station sequences; the
  // client stitches the geometry it already has.
  const routeRuns: Record<string, { slot: number; shared: number; stops: string[] }[]> = {};
  for (const [route, keySet] of Object.entries(routeSegmentList)) {
    const edges = keySet
      .filter((k) => segments[k])
      .map((k) => {
        const [a, b] = k.split("-");
        const [slot, shared] = segmentSlots[k]?.[route] ?? [0, 1];
        return { k, a, b, slot, shared };
      });
    const adj = new Map<string, typeof edges>();
    for (const e of edges) {
      (adj.get(e.a) ?? adj.set(e.a, []).get(e.a)!).push(e);
      (adj.get(e.b) ?? adj.set(e.b, []).get(e.b)!).push(e);
    }
    const used = new Set<string>();
    const runs: { slot: number; shared: number; stops: string[] }[] = [];
    /** Extend from `station` while exactly one unused edge continues with the same lane. */
    const extend = (station: string, slot: number, stops: string[], append: boolean) => {
      let cur = station;
      for (;;) {
        const options = (adj.get(cur) ?? []).filter((e) => !used.has(e.k) && e.slot === slot);
        if (options.length !== 1) break;
        const e = options[0];
        used.add(e.k);
        cur = e.a === cur ? e.b : e.a;
        if (append) stops.push(cur); else stops.unshift(cur);
      }
    };
    for (const e of edges) {
      if (used.has(e.k)) continue;
      used.add(e.k);
      const stops = [e.a, e.b];
      extend(e.b, e.slot, stops, true);
      extend(e.a, e.slot, stops, false);
      runs.push({ slot: e.slot, shared: e.shared, stops });
    }
    routeRuns[route] = runs;
  }
  const runCount = Object.values(routeRuns).reduce((n, r) => n + r.length, 0);
  const segCount = Object.values(routeSegmentList).reduce((n, r) => n + r.length, 0);
  console.log(`runs: ${segCount} route-segments chained into ${runCount} continuous strokes`);

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
    complexOf,
    complexes,
    shapeStops,
    segmentSlots,
    trackSlots,
    routeRuns,
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
