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
  /** Metres between two points, good enough over a city. */
  const distM = (a: LonLat, b: LonLat) => {
    const cos = Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
    return Math.hypot((b[0] - a[0]) * 111_320 * cos, (b[1] - a[1]) * 111_320);
  };
  /** Metres from a point to a line segment, for asking how closely two tracks run together. */
  const pointToSegmentM = (p: LonLat, a: LonLat, b: LonLat) => {
    const cos = Math.cos((p[1] * Math.PI) / 180);
    const px = (p[0] - a[0]) * 111_320 * cos, py = (p[1] - a[1]) * 111_320;
    const bx = (b[0] - a[0]) * 111_320 * cos, by = (b[1] - a[1]) * 111_320;
    const len2 = bx * bx + by * by;
    const t = len2 ? Math.max(0, Math.min(1, (px * bx + py * by) / len2)) : 0;
    return Math.hypot(px - bx * t, py - by * t);
  };

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

  /**
   * Corridor layout — which band each service occupies where several share a right of way.
   *
   * Two things changed here from the first version, both because the map wobbled. Bands are now
   * per *service* rather than per trunk colour, which is what the MTA's own 2025 map does: the 4,
   * 5 and 6 are three green bands, not one. And corridor membership is decided by whole-segment
   * overlap rather than by sampling cells and comparing bearings, because that sampling was not
   * stable — the F changed band at 2 Av and again at 7 Av with the corridor around it completely
   * unchanged, purely because a few samples fell the other side of a threshold. Sixty percent of
   * the lane changes in the network were that artefact rather than anything real.
   */
  const order = (r: string) => routes[r]?.sortOrder ?? 999;
  const CORRIDOR_M = 45;
  const SHARE_MIN = 0.6;
  const CELL = 250;

  const segKeys = Object.keys(segments);
  /** Points along a segment at a fixed spacing, for asking "how much of this runs beside that". */
  const probes = new Map<string, LonLat[]>();
  for (const k of segKeys) {
    const pts = segments[k];
    const out: LonLat[] = [];
    let carry = 0;
    for (let i = 0; i + 1 < pts.length; i++) {
      const d = distM(pts[i], pts[i + 1]);
      for (let t = carry; t < d; t += 40) out.push([pts[i][0] + ((pts[i + 1][0] - pts[i][0]) * t) / d, pts[i][1] + ((pts[i + 1][1] - pts[i][1]) * t) / d]);
      carry = Math.max(0, carry + Math.ceil((d - carry) / 40) * 40 - d);
    }
    if (!out.length) out.push(pts[0]);
    probes.set(k, out);
  }
  const bucket = (p: LonLat) => `${Math.round((p[0] * 111_320 * Math.cos((p[1] * Math.PI) / 180)) / CELL)}:${Math.round((p[1] * 111_320) / CELL)}`;
  const grid = new Map<string, Set<string>>();
  for (const k of segKeys) for (const p of probes.get(k)!) (grid.get(bucket(p)) ?? grid.set(bucket(p), new Set()).get(bucket(p))!).add(k);

  const nearPolyline = (p: LonLat, pts: LonLat[]) => {
    let best = Infinity;
    for (let i = 0; i + 1 < pts.length; i++) {
      const d = pointToSegmentM(p, pts[i], pts[i + 1]);
      if (d < best) best = d;
      if (best < CORRIDOR_M) return best;
    }
    return best;
  };

  /** Routes running alongside each segment, itself included. */
  const corridors = new Map<string, string[]>();
  /** Pairs of stretches found to run beside one another, for the orientation solver. */
  const besides: [string, string][] = [];
  for (const key of segKeys) {
    const own = [...(routeSegments_.get(key) ?? [])];
    if (!own.length) continue;
    const mine = probes.get(key)!;
    const candidates = new Set<string>();
    for (const p of mine) for (const k2 of grid.get(bucket(p)) ?? []) if (k2 !== key) candidates.add(k2);
    const alongside = new Set(own);
    for (const k2 of candidates) {
      const others = routeSegments_.get(k2) ?? [];
      if (!others.length || others.every((r) => alongside.has(r))) continue;
      const pts = segments[k2];
      let covered = 0;
      for (const p of mine) if (nearPolyline(p, pts) < CORRIDOR_M) covered++;
      if (covered / mine.length >= SHARE_MIN) {
        for (const r of others) alongside.add(r);
        if (key < k2) besides.push([key, k2]);
      }
    }
    corridors.set(key, [...alongside].sort((a, b) => order(a) - order(b) || (a < b ? -1 : 1)));
  }

  // An isolated disagreement between two identical neighbours is noise, not topology. One pass of
  // smoothing along each route's own chain removes the flickers the overlap test still produces.
  const byStation = new Map<string, Map<string, string[]>>();
  for (const [route, keys] of Object.entries(routeSegmentList)) {
    const m = new Map<string, string[]>();
    for (const k of keys) if (segments[k]) for (const st of k.split("-")) (m.get(st) ?? m.set(st, []).get(st)!).push(k);
    byStation.set(route, m);
  }
  let smoothed = 0;
  for (const [route, stationMap] of byStation) {
    for (const key of routeSegmentList[route] ?? []) {
      if (!segments[key]) continue;
      const [u, v] = key.split("-");
      const before = (stationMap.get(u) ?? []).filter((k) => k !== key);
      const after = (stationMap.get(v) ?? []).filter((k) => k !== key);
      if (before.length !== 1 || after.length !== 1) continue;
      const neighbour = corridors.get(before[0]);
      const a = neighbour?.join(","), b = corridors.get(after[0])?.join(",");
      const here = corridors.get(key)?.join(",");
      // Only adopt a neighbour's corridor if it still accounts for everything running here.
      // Adopting a narrower one drops this segment's own services out of the ordering, and they
      // then all land on band zero on top of each other.
      if (!neighbour || !a || a !== b || here === a) continue;
      if (!(routeSegments_.get(key) ?? []).every((r) => neighbour.includes(r))) continue;
      corridors.set(key, [...neighbour]);
      smoothed++;
    }
  }

  /**
   * Which way each segment "runs".
   *
   * A band is drawn a fixed distance to one side of the centreline, and which side that is
   * depends on the direction the segment's points are stored in. Segment keys are ordered by
   * station id, which has nothing to do with geography: where a station id sorts after both of
   * its neighbours, the two segments either side of it both point *into* it, their perpendiculars
   * oppose, and the same band lands on opposite sides of the track. That mirrored a service onto
   * the wrong side of its corridor, and showed up as strokes ending a clean two bands apart.
   *
   * So each segment gets an orientation propagated across stations between stretches of track
   * that actually continue into one another — a turn of less than 60 degrees. Junctions do not
   * propagate, because there is no sense in which a branch continues the trunk.
   */
  const awayFrom = (k: string, st: string): LonLat => {
    const pts = segments[k];
    const [u] = k.split("-");
    const [a, b] = u === st ? [pts[0], pts[1] ?? pts[0]] : [pts[pts.length - 1], pts[pts.length - 2] ?? pts[pts.length - 1]];
    const cos = Math.cos((a[1] * Math.PI) / 180);
    const e = (b[0] - a[0]) * cos, n = b[1] - a[1];
    const len = Math.hypot(e, n) || 1;
    return [e / len, n / len];
  };
  const stationSegs = new Map<string, string[]>();
  for (const k of segKeys) if (segments[k]) for (const st of k.split("-")) (stationSegs.get(st) ?? stationSegs.set(st, []).get(st)!).push(k);

  /**
   * The stretches meeting at a station, partitioned into the lines that actually run through it.
   *
   * Blending a band change needs a group every member agrees on, or the two sides ease to
   * different places and part company. Asking each stretch for "the ones that continue from me"
   * does not give that — the relation is symmetric but the groups it produces are not. So the
   * relation is closed into equivalence classes: every stretch in a class sees the same class,
   * the mean of their bands is the same number for all of them, and the change closes exactly.
   *
   * A branch forms a class of its own and keeps its band, which is what stops a junction from
   * pinching every line down to one band before fanning them out again.
   */
  const throughClass = new Map<string, Map<string, string[]>>();
  for (const [st, ks] of stationSegs) {
    const parent = new Map(ks.map((k) => [k, k]));
    const find = (k: string): string => (parent.get(k) === k ? k : (parent.set(k, find(parent.get(k)!)), parent.get(k)!));
    for (let i = 0; i < ks.length; i++) {
      const here = awayFrom(ks[i], st);
      for (let j = i + 1; j < ks.length; j++) {
        const there = awayFrom(ks[j], st);
        if (here[0] * there[0] + here[1] * there[1] <= -0.5) parent.set(find(ks[i]), find(ks[j]));
      }
    }
    const classes = new Map<string, string[]>();
    for (const k of ks) (classes.get(find(k)) ?? classes.set(find(k), []).get(find(k))!).push(k);
    throughClass.set(st, new Map(ks.map((k) => [k, classes.get(find(k))!])));
  }

  /**
   * Which way each stretch runs, agreed across the whole network.
   *
   * Two stretches that continue into one another want the same orientation. Spreading one
   * outwards from a seed satisfies almost all of those wishes, but the network has cycles — go
   * round a loop and the far side can disagree with where you started. Taking the first answer
   * and leaving the disagreement is what put a two-band step in the middle of a line.
   *
   * So the spread is followed by a settling pass: any stretch that disagrees with more of its
   * neighbours than it agrees with is flipped, repeatedly, until nothing improves. It is a local
   * search and it cannot promise perfection — a cycle of odd parity has no consistent answer at
   * all — but it moves the remaining disagreements to where they cost least.
   */
  /**
   * The constraints, and how much each one costs to break.
   *
   * Orientation is one global sign per stretch, and every pair of stretches that have any
   * business being on the same side of the track is a constraint on those signs. There are three
   * kinds, and they are not equally important:
   *
   *  - A service running from one stretch into the next. This is the one a rider sees: break it
   *    and a line crosses to the other side of its own corridor in the middle of a run. The
   *    parity is exact and no angle comes into it — travel arrives at the station along one
   *    stretch and leaves along the other.
   *  - Two stretches that continue into one another geometrically, whether or not a service
   *    happens to run through. This is what keeps a corridor coherent past a station no route
   *    runs through.
   *  - Two stretches running alongside each other without meeting — an express chain beside a
   *    local one. Mirror one of those against the other and the two halves of a four-track
   *    corridor are ordered in opposite directions.
   *
   * Only the second kind used to be collected, and only for turns under 60 degrees, so a service
   * turning harder than that — the E through Queens Plaza, the N through Lexington Av/63 St, the
   * G through Hoyt-Schermerhorn — passed into a component that had been seeded on its own. Its
   * band came out mirrored, which drew as a line crossing everything beside it and then crossing
   * back. Along Queens Boulevard that was eight crossings between the F and the diamond F alone.
   */
  const W_ROUTE = 4, W_THROUGH = 2, W_BESIDE = 1;
  type Link = { other: string; same: boolean; w: number };
  const links = new Map<string, Link[]>();
  const linked = new Set<string>();
  const addLink = (a: string, b: string, same: boolean, w: number) => {
    // One constraint per pair per kind. A pair carried by forty shapes is not forty times as
    // important as one carried by a single shape; it is the same fact, observed repeatedly.
    const id = `${a < b ? a : b}|${a < b ? b : a}|${w}`;
    if (linked.has(id)) return;
    linked.add(id);
    (links.get(a) ?? links.set(a, []).get(a)!).push({ other: b, same, w });
    (links.get(b) ?? links.set(b, []).get(b)!).push({ other: a, same, w });
  };
  /** Whether a stretch's stored order finishes at this station rather than starting from it. */
  const endsAt = (k: string, st: string) => k.split("-")[1] === st;

  /*
   * Read off the ordered stop lists rather than from "which stretches touch this station".
   *
   * Asking the station is only unambiguous where a service has exactly two stretches there, and
   * on this network that is the minority: a route running both express and local patterns has
   * three, four, five. The E has five stretches at Kew Gardens, the N four at 57 St-7 Av. Every
   * one of those junctions was being skipped, which is precisely where the orientation broke —
   * Queens Plaza, Court Sq, Lexington Av/63 St. A shape's stop list says which stretch actually
   * follows which, so there is nothing to infer.
   */
  for (const stops of Object.values(shapeStops)) {
    let prev: string | null = null;
    let prevKey: string | null = null;
    for (const sid of stops) {
      const here = parent(sid);
      if (prev && prev !== here) {
        const key = prev < here ? `${prev}-${here}` : `${here}-${prev}`;
        if (segments[key]) {
          if (prevKey && (prevKey.split("-").includes(prev))) {
            addLink(prevKey, key, endsAt(prevKey, prev) !== endsAt(key, prev), W_ROUTE);
          }
          prevKey = key;
        } else prevKey = null;
      }
      prev = here;
    }
  }
  for (const k of segKeys) {
    if (!segments[k]) continue;
    for (const st of k.split("-")) {
      const here = awayFrom(k, st);
      for (const k2 of stationSegs.get(st) ?? []) {
        if (k2 <= k || !segments[k2]) continue;
        const there = awayFrom(k2, st);
        // Both vectors point away from the station, so a straight-through pair points opposite.
        if (here[0] * there[0] + here[1] * there[1] > -0.5) continue;
        addLink(k, k2, endsAt(k, st) !== endsAt(k2, st), W_THROUGH);
      }
    }
  }
  const dirOf = (k: string) => {
    const pts = segments[k];
    const a = pts[0], b = pts[pts.length - 1];
    const cos = Math.cos((a[1] * Math.PI) / 180);
    const e = (b[0] - a[0]) * cos, n = b[1] - a[1];
    const len = Math.hypot(e, n) || 1;
    return [e / len, n / len] as [number, number];
  };
  for (const [a, b] of besides) {
    if (!segments[a] || !segments[b]) continue;
    const da = dirOf(a), db = dirOf(b);
    addLink(a, b, da[0] * db[0] + da[1] * db[1] > 0, W_BESIDE);
  }

  /**
   * Solve for the signs.
   *
   * Spreading outwards from an arbitrary seed satisfies almost every constraint, but the network
   * has cycles: go round one and you can come back disagreeing with where you started. Which
   * constraint ends up carrying that disagreement is then decided by whichever stretch the walk
   * happened to reach first, and it was landing on the ones a rider sees.
   *
   * So the signs are laid down along a maximum-weight spanning forest instead. Every constraint
   * in the forest is satisfied exactly — a tree has no cycles to frustrate — and because the
   * heaviest edges are taken first, what is left outside it is the cheapest set of constraints
   * available. A local search then flips whatever still disagrees with more of its neighbours
   * than it agrees with, weighted, until nothing improves.
   *
   * What survives is a genuine frustration: a cycle whose parities cannot all hold at once, which
   * no assignment of signs would satisfy. Those are reported rather than hidden.
   */
  const edges: { a: string; b: string; same: boolean; w: number }[] = [];
  for (const [k, ls] of links) for (const l of ls) if (k < l.other) edges.push({ a: k, b: l.other, same: l.same, w: l.w });
  edges.sort((x, y) => y.w - x.w);

  const treeOf = new Map<string, string>();
  const root = (k: string): string => (treeOf.get(k) === k ? k : (treeOf.set(k, root(treeOf.get(k)!)), treeOf.get(k)!));
  for (const k of segKeys) if (segments[k]) treeOf.set(k, k);
  const tree = new Map<string, { other: string; same: boolean }[]>();
  for (const e of edges) {
    if (!treeOf.has(e.a) || !treeOf.has(e.b) || root(e.a) === root(e.b)) continue;
    treeOf.set(root(e.a), root(e.b));
    (tree.get(e.a) ?? tree.set(e.a, []).get(e.a)!).push({ other: e.b, same: e.same });
    (tree.get(e.b) ?? tree.set(e.b, []).get(e.b)!).push({ other: e.a, same: e.same });
  }

  const segDir: Record<string, number> = {};
  for (const seed of segKeys) {
    if (segDir[seed] !== undefined || !segments[seed]) continue;
    segDir[seed] = 1;
    const queue = [seed];
    while (queue.length) {
      const k = queue.shift()!;
      for (const { other, same } of tree.get(k) ?? []) {
        if (segDir[other] !== undefined) continue;
        segDir[other] = same ? segDir[k] : -segDir[k];
        queue.push(other);
      }
    }
  }

  /** What the current assignment costs, and how much of that a rider would actually see. */
  const conflictCost = () => {
    let cost = 0, routeBreaks = 0;
    for (const e of edges) {
      if ((segDir[e.a] === segDir[e.b]) === e.same) continue;
      cost += e.w;
      if (e.w >= W_ROUTE) routeBreaks++;
    }
    return { cost, routeBreaks };
  };
  const before = conflictCost();
  for (let sweep = 0; sweep < 40; sweep++) {
    let flipped = 0;
    for (const [k, ls] of links) {
      let agree = 0, disagree = 0;
      for (const { other, same, w } of ls) {
        if (segDir[other] === undefined) continue;
        if ((segDir[k] === segDir[other]) === same) agree += w; else disagree += w;
      }
      if (disagree > agree) { segDir[k] = -segDir[k]; flipped++; }
    }
    if (!flipped) break;
  }
  const after = conflictCost();
  const orientConflicts = after.routeBreaks;
  console.log(`  orientation: ${links.size} stretches, ${edges.length} constraints, cost ${before.cost} -> ${after.cost}, ${after.routeBreaks} irreducible`);

  const segmentSlots: Record<string, Record<string, [number, number]>> = {};
  /**
   * Two readings of the same position, and the map crossfades between them.
   *
   *  - The **metric** band is where the track actually is: services evenly spaced across the
   *    corridor, one track apart, in a fixed order.
   *  - The **colour** index is where the printed map puts it: one line per trunk colour,
   *    whatever the colour is carrying, so the 4, 5 and 6 are a single green Lexington line.
   *
   * Zoomed out you see the second; zoomed in, the first; in between, a blend. Both are stored so
   * the renderer can interpolate between them rather than trying to add them together.
   *
   * They used to be a split rather than a pair — a colour part and a service-within-colour part
   * — and the drawn geometry was offset by the metric band while the screen fan was offset by
   * that split. Two different orderings, summed. Along Queens Boulevard the E sat one track from
   * the F in the data and a whole colour width from it on screen, so the five lines bunched,
   * crossed and changed spacing as you zoomed. There is one ordering now, and one blend.
   */
  const bandParts: Record<string, Record<string, [number, number]>> = {};
  /**
   * Stretches that run beside one another share one ordering.
   *
   * A band is an index into the services sharing a corridor, and that list was built per stretch.
   * The express and local halves of a four-track corridor are different stretches with different
   * lists, so the same index can mean the third of five on one and the third of three on the
   * other — two services, one band, drawn on exactly the same line. At Forest Hills the M and the
   * diamond F were 0.0 px apart.
   *
   * The stretches found running alongside each other are grouped, and every member reads the same
   * list. The grouping is tight: the widest is eight services over four stretches, so this cannot
   * quietly chain the whole system into one corridor.
   */
  const corridorRoot = new Map<string, string>();
  {
    const rootOf = (k: string): string => (corridorRoot.get(k) === k ? k : (corridorRoot.set(k, rootOf(corridorRoot.get(k)!)), corridorRoot.get(k)!));
    for (const k of segKeys) if (segments[k]) corridorRoot.set(k, k);
    for (const [a, b] of besides) if (corridorRoot.has(a) && corridorRoot.has(b)) corridorRoot.set(rootOf(a), rootOf(b));
    for (const k of [...corridorRoot.keys()]) corridorRoot.set(k, rootOf(k));
  }
  const groupCorridor = new Map<string, string[]>();
  for (const [key, corridor] of corridors) {
    const root = corridorRoot.get(key) ?? key;
    const list = groupCorridor.get(root) ?? groupCorridor.set(root, []).get(root)!;
    for (const r of corridor) if (!list.includes(r)) list.push(r);
    for (const r of routeSegments_.get(key) ?? []) if (!list.includes(r)) list.push(r);
  }
  for (const list of groupCorridor.values()) list.sort((a, b) => order(a) - order(b) || (a < b ? -1 : 1));

  for (const [key, corridor] of corridors) {
    void corridor;
    // Belt and braces: a service running here always has a place in the ordering, so two can
    // never be handed the same band and drawn on top of each other.
    const band = [...(groupCorridor.get(corridorRoot.get(key) ?? key) ?? [])];
    for (const r of routeSegments_.get(key) ?? []) if (!band.includes(r)) band.push(r);
    const n = band.length;
    const colourOf = (r: string) => routes[r]?.color ?? r;
    const colours: string[] = [];
    for (const r of band) if (!colours.includes(colourOf(r))) colours.push(colourOf(r));
    const slots: Record<string, [number, number]> = {};
    const parts: Record<string, [number, number]> = {};
    for (const r of routeSegments_.get(key) ?? []) {
      const metric = band.indexOf(r) - (n - 1) / 2;
      slots[r] = [metric, n];
      parts[r] = [colours.indexOf(colourOf(r)) - (colours.length - 1) / 2, metric];
    }
    segmentSlots[key] = slots;
    bandParts[key] = parts;
  }

  const routeAdj: { a: string; b: string; route: string }[] = [];
  for (const [shape, stops] of Object.entries(shapeStops)) {
    const route = shape.split(/[._]/)[0];
    if (!routes[route]) continue;
    let prev = "", prevKey = "";
    for (const sid of stops) {
      const here: string = parent(sid);
      if (prev && prev !== here) {
        const key = prev < here ? `${prev}-${here}` : `${here}-${prev}`;
        if (segments[key] && segmentSlots[key]?.[route]) {
          if (prevKey && segmentSlots[prevKey]?.[route]) routeAdj.push({ a: prevKey, b: key, route });
          prevKey = key;
        } else prevKey = "";
      }
      prev = here;
    }
  }


  /**
   * Where a service changes band it must not step sideways. `laneEnds` records the offset each
   * end of a segment should reach, halfway between this band and the neighbouring one, so the
   * change is drawn as a splay straddling the station — each side ramping to meet the other —
   * rather than as a break. Trains read the same numbers, so a train stays on its own line
   * through the transition.
   */
  const laneEnds: Record<string, Record<string, [number, number]>> = {};
  /**
   * The same, for the colour reading.
   *
   * The map crossfades between where the track is and where the printed map puts the line, so a
   * step in either is a step on screen — the colour one showing up when you are zoomed out far
   * enough for a trunk to be a single line. Both readings ease into their neighbours' the same
   * way, from the same blend.
   */
  const colourEnds: Record<string, Record<string, [number, number]>> = {};
  for (const [route, stationMap] of byStation) {
    for (const key of routeSegmentList[route] ?? []) {
      if (!segments[key]) continue;
      const [u, v] = key.split("-");
      // A stretch eases to the mean of the bands this service uses on the stretches that carry
      // straight on from it. Each one computes the same mean, so a change of band closes exactly.
      //
      // Only straight-through stretches count. Including branches too made every line at a
      // junction converge on one band before fanning out again, which drew a visible pinch at
      // Canal St and everywhere else services part company. A branch is already heading away;
      // it does not need dragging sideways first.
      const blend = (band: (k: string) => number | undefined) => (station: string) => {
        const mine = band(key) ?? 0;
        // Where a service has exactly two stretches at a station it is passing through, however
        // sharply. The geometric "carries straight on" test wants a turn of under 60 degrees,
        // which is right for deciding what a *corridor* does and wrong for one service's own
        // continuity: the N through Union Sq, the E through Queens Plaza and the 4 through
        // Brooklyn Bridge all curve harder than that, and each was left with a step of up to
        // 6.9 m in the middle of an otherwise continuous line.
        //
        // Deriving the group from the shapes instead was tried and is worse: closing "what
        // follows what" into equivalence classes merges a service's express and local paths
        // through the same station into one group, and both then pinch toward a shared mean.
        const mineHere = (stationMap.get(station) ?? []).filter((k) => segmentSlots[k]?.[route]);
        const group = (mineHere.length === 2 ? mineHere : throughClass.get(station)?.get(key) ?? [key])
          .filter((k) => segmentSlots[k]?.[route]);
        if (group.length < 2) return mine;
        // A slot is already in the corridor's frame: the drawing offsets by `slot * segDir`
        // relative to the stored point order, which is `slot` relative to the corridor's own
        // direction. Converting again here applies the orientation twice — invisible wherever
        // neighbouring stretches share an orientation, and a 6.9 m step where they do not.
        return group.reduce((sum, k) => sum + (band(k) ?? 0), 0) / group.length;
      };
      const metric = blend((k) => segmentSlots[k]?.[route]?.[0]);
      const colour = blend((k) => bandParts[k]?.[route]?.[0]);
      (laneEnds[key] ??= {})[route] = [metric(u), metric(v)];
      (colourEnds[key] ??= {})[route] = [colour(u), colour(v)];
    }
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
  console.log(`corridors: ${shared} of ${Object.keys(segmentSlots).length} segments share track (${smoothed} flickers smoothed, ${orientConflicts} orientation conflicts)`);

  // --- Continuous runs --------------------------------------------------------
  // Drawing one disconnected feature per segment leaves a hard butt end wherever a lane changes,
  // which is what makes a converging line look like it was cut off. Instead, chain each route's
  // segments into the longest runs that keep the same lane, so a line is one continuous stroke
  // from where it joins a corridor to where it leaves. Runs are stored as station sequences; the
  // client stitches the geometry it already has.
  /**
   * Draw order for the weave. Where two bands cross, one has to pass over the other, and the
   * choice cannot be per-crossing or the same pair would weave one way here and the other way
   * there. Bands further right always pass over bands further left, so a service changing band
   * goes over or under consistently along its whole length — which is what makes the crossing
   * read as a weave rather than as a mistake. Nine levels covers the widest corridor in the
   * system, whose bands run from -3.5 to 3.5; with five, the outermost pair of an eight-service
   * corridor was clamped onto its neighbour's level and the crossing could not show.
   */
  const WEAVE_LEVELS = 9;
  const zOf = (slot: number) => Math.max(0, Math.min(WEAVE_LEVELS - 1, Math.round(slot + (WEAVE_LEVELS - 1) / 2)));
  /**
   * Which way a drawn stroke runs relative to its corridor. The renderer offsets a line to the
   * right of the direction it is drawn in, so a stroke drawn against its corridor needs its band
   * negated or it fans out on the wrong side.
   */
  const sideOf = (a: string, b: string) => {
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    return (segDir[key] ?? 1) * (a < b ? 1 : -1);
  };
  let sideFlips = 0;
  const routeRuns: Record<string, { slot: number; shared: number; z: number; side: number; cband: number; sband: number; stops: string[] }[]> = {};
  for (const [route, keySet] of Object.entries(routeSegmentList)) {
    const edges = keySet
      .filter((k) => segments[k])
      .map((k) => {
        const [a, b] = k.split("-");
        const [slot, shared] = segmentSlots[k]?.[route] ?? [0, 1];
        const [cband, sband] = bandParts[k]?.[route] ?? [0, 0];
        return { k, a, b, slot, shared, cband, sband, lane: `${slot}|${cband}` };
      });
    const adj = new Map<string, typeof edges>();
    for (const e of edges) {
      (adj.get(e.a) ?? adj.set(e.a, []).get(e.a)!).push(e);
      (adj.get(e.b) ?? adj.set(e.b, []).get(e.b)!).push(e);
    }
    const used = new Set<string>();
    const runs: { slot: number; shared: number; z: number; side: number; cband: number; sband: number; stops: string[] }[] = [];
    /** Extend from `station` while exactly one unused edge continues with the same lane. */
    const extend = (station: string, lane: string, stops: string[], append: boolean) => {
      let cur = station;
      for (;;) {
        const options = (adj.get(cur) ?? []).filter((e) => !used.has(e.k) && e.lane === lane);
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
      extend(e.b, e.lane, stops, true);
      extend(e.a, e.lane, stops, false);
      // A stroke is offset as one feature, so it must be drawn on one side of its corridor all
      // the way along. Where the corridor's orientation reverses mid-stroke — at a sharp turn the
      // orientation pass would not propagate through — the stroke is cut there instead.
      let from = 0, side = sideOf(stops[0], stops[1]);
      for (let i = 1; i + 1 < stops.length; i++) {
        const here = sideOf(stops[i], stops[i + 1]);
        if (here === side) continue;
        runs.push({ slot: e.slot, shared: e.shared, z: zOf(e.slot), side, cband: e.cband, sband: e.sband, stops: stops.slice(from, i + 1) });
        sideFlips++;
        from = i;
        side = here;
      }
      runs.push({ slot: e.slot, shared: e.shared, z: zOf(e.slot), side, cband: e.cband, sband: e.sband, stops: stops.slice(from) });
    }
    routeRuns[route] = runs;
  }
  const runCount = Object.values(routeRuns).reduce((n, r) => n + r.length, 0);
  const segCount = Object.values(routeSegmentList).reduce((n, r) => n + r.length, 0);
  console.log(`runs: ${segCount} route-segments chained into ${runCount} continuous strokes (${sideFlips} cut where the corridor reverses)`);

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
    bandParts,
    laneEnds,
    colourEnds,
    segDir,
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

  /*
   * A second, smaller file with the map's geometry left out.
   *
   * A board needs station names, the routes that serve them and the complexes they belong to. It
   * does not need a single polyline. Those polylines and the band layout derived from them are
   * about two thirds of the file, and on a slow connection the whole thing sat on the critical
   * path — the countdown a rider opened the app for waited behind the geometry of a map they had
   * not looked at yet. The map fetches the full file when it mounts, which is after the board.
   */
  const GEOMETRY_ONLY = ["segments", "segmentSlots", "bandParts", "laneEnds", "colourEnds", "segDir", "routeRuns"] as const;
  const lite = Object.fromEntries(Object.entries(out).filter(([k]) => !(GEOMETRY_ONLY as readonly string[]).includes(k)));
  const liteOut = join(ROOT, "public", "data", "network-lite.json");
  writeFileSync(liteOut, JSON.stringify(lite));
  console.log(`  network-lite.json ${Math.round(readFileSync(liteOut).length / 1024)} KB (board only; the map fetches the full file)`);
  const kb = Math.round(readFileSync(OUT).length / 1024);
  console.log(
    `Wrote ${OUT} (${kb} KB): ${Object.keys(routes).length} routes, ${Object.keys(stations).length} stations, ` +
      `${Object.keys(segments).length} segments (${straightFallbacks} straight-line fallbacks)`,
  );
}

main().catch((e) => { console.error(e); process.exit(1); });
