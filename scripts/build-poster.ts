/**
 * The loading poster: the network as the map draws it at the home view, as one small SVG.
 *
 * On a slow connection the map is the last thing to arrive: the engine, the geometry and the
 * basemap tiles add up to about fifteen seconds on slow 4G, and until then the top two thirds of a
 * phone was a black rectangle. The poster is in the first paint instead, so the subway is on
 * screen from the start and the live map fades in over a picture of itself.
 *
 * It is drawn from the same strokes, bands and widths as the real line layer, and centred on
 * HOME, so the two coincide: the poster's own size places it, and the page only has to centre it.
 *
 * Usage: npx tsx scripts/build-poster.ts   (also run by `npm run build:network`)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NetworkIndex, casingWidthAt, fanAt, lineWidthAt } from "../src/lib/network";
import { HOME, project } from "../src/lib/home";
import { PALETTE } from "../src/lib/palette";
import type { Network } from "../src/lib/types";

const ROOT = join(import.meta.dirname, "..");
const OUT = join(ROOT, "public/data/poster.svg");
const net = JSON.parse(readFileSync(join(ROOT, "public/data/network.json"), "utf8")) as Network;
const idx = new NetworkIndex(net);

const Z = HOME.zoom;
const [cx, cy] = project(HOME.lon, HOME.lat, Z);
const fan = fanAt(Z);
/** Under a quarter of a pixel, a point changes nothing anyone can see. */
const TOLERANCE_PX = 0.25;

type P = [number, number];

/** Ramer–Douglas–Peucker, iterative. */
function simplify(pts: P[], tol: number): P[] {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
    let worst = -1, at = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[i][0] - ax) * dy - (pts[i][1] - ay) * dx) / len;
      if (d > worst) { worst = d; at = i; }
    }
    if (worst > tol) { keep[at] = 1; stack.push([a, at], [at, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

/**
 * A stroke, projected and pushed out to its band.
 *
 * The line shader offsets each vertex along the normal to the right of travel by the stroke's band
 * read through the fan, which is what keeps the 4, 5 and 6 from being drawn on one another. The
 * same displacement, applied here in screen pixels (y down, so the right-hand normal of (dx, dy)
 * is (-dy, dx)).
 */
function laid(pts: [number, number][], band: number): P[] {
  const xy: P[] = pts.map(([lon, lat]) => {
    const [x, y] = project(lon, lat, Z);
    return [x - cx, y - cy];
  });
  if (!band) return xy;
  return xy.map((p, i) => {
    const a = xy[Math.max(0, i - 1)], b = xy[Math.min(xy.length - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
    if (!len) return p;
    return [p[0] + (-dy / len) * band, p[1] + (dx / len) * band];
  });
}

const r1 = (v: number) => Math.round(v * 10) / 10;
function pathOf(pts: P[]): string {
  let d = "";
  let px = 0, py = 0;
  pts.forEach(([x, y], i) => {
    const X = r1(x), Y = r1(y);
    // Relative after the first point: shorter numbers, and the file is mostly numbers.
    d += i === 0 ? `M${X} ${Y}` : `l${r1(X - px)} ${r1(Y - py)}`;
    px = X; py = Y;
  });
  return d.replace(/ -/g, "-");
}

/*
 * The strokes, joined back into runs and drawn once each.
 *
 * The line engine cuts a run wherever its band changes, so the gradual ramps around a junction
 * arrive as dozens of four-point pieces — half the strokes in the network. Drawn separately that
 * was 145 KB of path data, most of it the overhead of starting a path. A run is one polyline here.
 *
 * And where several services share a trunk colour and a corridor, the home zoom draws them as one
 * line: the 4, 5 and 6 are the same green stroke at 11.4. A piece already drawn, in its colour,
 * to the nearest pixel, is not drawn again.
 */
const seen = new Set<string>();
const runs: { z: number; colour: string; pts: P[] }[] = [];
let cur: { run: string; z: number; colour: string; pts: P[] } | null = null;
const flush = () => { if (cur && cur.pts.length > 1) runs.push(cur); cur = null; };
for (const s of idx.strokes()) {
  if (s.pts.length < 2) continue;
  const pts = laid(s.pts, s.cb * fan.colour + s.mb * fan.metric);
  const key = s.colour + pts.map(([x, y]) => `${Math.round(x)},${Math.round(y)}`).join(";");
  if (seen.has(key)) { flush(); continue; }
  seen.add(key);
  const last = cur?.pts[cur.pts.length - 1];
  const joins = cur && cur.run === s.run && last && Math.hypot(last[0] - pts[0][0], last[1] - pts[0][1]) < 1;
  if (!joins) { flush(); cur = { run: s.run, z: s.z, colour: s.colour, pts: [...pts] }; }
  else cur!.pts.push(...pts.slice(1));
}
flush();

// The weave: casing then line, level by level, lowest first — the order the line layer draws in,
// which is what makes a crossing read as one line passing under another.
const byLevel = new Map<number, Map<string, string[]>>();
let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
let points = 0;
for (const r of runs) {
  const pts = simplify(r.pts, TOLERANCE_PX);
  points += pts.length;
  for (const [x, y] of pts) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  const level = byLevel.get(r.z) ?? byLevel.set(r.z, new Map()).get(r.z)!;
  (level.get(r.colour) ?? level.set(r.colour, []).get(r.colour)!).push(pathOf(pts));
}

const casing = casingWidthAt(Z), line = lineWidthAt(Z);
// Symmetric about the centre, so centring the image centres HOME.
const w = 2 * Math.ceil(Math.max(-minX, maxX) + casing), h = 2 * Math.ceil(Math.max(-minY, maxY) + casing);

let body = "";
for (const z of [...byLevel.keys()].sort((a, b) => a - b)) {
  const level = byLevel.get(z)!;
  const all = [...level.values()].flat().join("");
  body += `<path stroke="${PALETTE["--map-casing"]}" stroke-opacity=".75" stroke-width="${casing.toFixed(2)}" d="${all}"/>`;
  for (const [colour, ds] of level) body += `<path stroke="${colour}" stroke-width="${line.toFixed(2)}" d="${ds.join("")}"/>`;
}
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${-w / 2} ${-h / 2} ${w} ${h}">`
  + `<g fill="none" stroke-linecap="round" stroke-linejoin="round">${body}</g></svg>\n`;
writeFileSync(OUT, svg);
console.log(`poster.svg: ${w}×${h} px at zoom ${Z}, ${points.toLocaleString()} points, ${Math.round(svg.length / 1024)} KB`);
