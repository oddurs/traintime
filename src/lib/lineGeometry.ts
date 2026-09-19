/**
 * Every drawn stretch of every service, baked once into the buffers a GPU wants.
 *
 * The network changes when the MTA publishes a feed version — which is to say rarely, and never
 * mid-session — and it was being handed to MapLibre as GeoJSON and re-tiled as though it were live
 * data. This turns it into what it actually is: static geometry that a camera moves over.
 *
 * A polyline becomes a triangle strip two vertices wide. Each vertex carries the point before it
 * and the point after it as well as its own, because the sideways extrusion has to happen in
 * *screen* space — that is where a pixel is defined — and the shader can only work out the screen
 * direction of a bend by projecting all three. Endpoints mark themselves by repeating their own
 * position, which the shader reads as "no neighbour this way".
 *
 * Each end carries a duplicate pair of vertices flagged as a cap. The shader pushes those out along
 * the line by exactly the half width and the fragment stage rounds the corner off, so the strip
 * ends in a disc rather than a square. They have to be their own vertices: the roundness is an
 * interpolation from 1 at the pushed-out pair to 0 at the real end, and if the real end carried the
 * flag there would be nothing to interpolate towards except the far end of the segment — which
 * would round the whole stretch instead of its last two pixels.
 *
 * Sorted by weave level, because the draw order is the whole trick: a casing and a line per level,
 * lowest first, so a band crossing another has its own casing drawn over the line beneath and the
 * crossing reads as one line passing under another rather than as two lines merging.
 */
import type { NetworkIndex } from "./network";

/** Floats per vertex. Thirteen, laid out so each vector lands on its own boundary. */
export const LINE_STRIDE = 13;

/** One stroke's triangles, and the box they live in, so a frame can skip what it cannot see. */
export interface LinePart {
  readonly z: number;
  readonly start: number;
  readonly count: number;
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export interface LineMesh {
  /** Interleaved: prev(2) pos(2) next(2) side(1) cap(1) band(2) colour(3). */
  readonly vertices: Float32Array;
  /** Triangles, into `vertices`. Under 65 536 vertices, so sixteen bits is enough. */
  readonly indices: Uint16Array;
  /** Where each weave level's triangles start and how many there are, indexed by level. */
  readonly levels: readonly { start: number; count: number }[];
  /** Route name per vertex, as an index into `routes`, for the visibility mask. */
  readonly routeOf: Uint8Array;
  readonly routes: readonly string[];
  /** Sorted by level, so a cull walks them in draw order. */
  readonly parts: readonly LinePart[];
  readonly vertexCount: number;
  readonly bytes: number;
}

/**
 * A CSS colour as the three floats a shader wants.
 *
 * The short hex form is not a nicety. `--map-casing` is authored as `#000000` and computes to
 * `#000`, and a parser that only knew the six-digit form fell through to the fallback and drew
 * every casing in the network magenta at three quarters opacity — which does not read as "a colour
 * failed to parse", it reads as the whole map having gone slightly wrong.
 */
export const parseColour = (c: string): [number, number, number] => {
  const s = c.trim();
  const h = /^#?([0-9a-f]{3,8})$/i.exec(s);
  if (h) {
    const d = h[1];
    // #rgb and #rgba double each digit; #rrggbb and #rrggbbaa are read as they are. Alpha is
    // dropped: opacity is the layer's business, not the colour's.
    const hexes = d.length === 3 || d.length === 4
      ? [d[0] + d[0], d[1] + d[1], d[2] + d[2]]
      : d.length === 6 || d.length === 8
        ? [d.slice(0, 2), d.slice(2, 4), d.slice(4, 6)]
        : null;
    if (hexes) return hexes.map((x) => parseInt(x, 16) / 255) as [number, number, number];
  }
  const r = /rgba?\(([^)]+)\)/i.exec(s);
  if (r) {
    const p = r[1].split(/[,\s/]+/).filter(Boolean).map((x) => parseFloat(x));
    return [(p[0] || 0) / 255, (p[1] || 0) / 255, (p[2] || 0) / 255];
  }
  // A colour we cannot read is a line drawn in the wrong colour, which is better than no line —
  // and magenta is the colour that gets noticed.
  return [1, 0, 1];
};

/** Mercator [0..1], the frame both this and the train layer draw in. */
const mx = (lon: number) => (lon + 180) / 360;
const my = (lat: number) => {
  const s = Math.sin((lat * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
};

/** How many weave levels the renderer draws. Matches `zOf()` in scripts/build-network.ts. */
export const WEAVE_LEVELS = 9;

export function buildLineMesh(index: NetworkIndex): LineMesh {
  const strokes = index.strokes().filter((s) => s.pts.length >= 2);

  // Sorted by level so each level's triangles are one contiguous range and can be drawn with one
  // call at the right moment in the weave.
  strokes.sort((a, b) => a.z - b.z);

  const routes: string[] = [];
  const routeIndex = new Map<string, number>();
  const routeIdOf = (r: string) => {
    let i = routeIndex.get(r);
    if (i === undefined) { i = routes.length; routes.push(r); routeIndex.set(r, i); }
    return i;
  };

  // Two extra points a stroke, one at each end, for the caps.
  let points = 0;
  for (const s of strokes) points += s.pts.length + 2;
  const vertexCount = points * 2;
  const vertices = new Float32Array(vertexCount * LINE_STRIDE);
  const routeOf = new Uint8Array(vertexCount);
  const indices = new Uint16Array(strokes.reduce((n, s) => n + (s.pts.length + 1) * 6, 0));

  const levels: { start: number; count: number }[] = [];
  for (let z = 0; z < WEAVE_LEVELS; z++) levels.push({ start: 0, count: 0 });

  const parts: LinePart[] = [];
  let v = 0, i = 0;
  let level = -1;
  for (const s of strokes) {
    if (s.z !== level) {
      // Close the previous level and open this one at the current index.
      level = s.z;
      if (level >= 0 && level < WEAVE_LEVELS) levels[level].start = i;
    }
    const rid = routeIdOf(s.route);
    const [cr, cg, cb] = parseColour(s.colour);
    const n = s.pts.length;
    const base = v;

    /*
     * The run of points, with a cap pair bracketing it. `at` is which point's position and
     * neighbours a vertex carries; `cap` is whether it is one of the pushed-out pairs. The cap pair
     * is a copy of the end it belongs to, so it bends the same way and rides the same band.
     */
    const emit = (at: number, cap: number) => {
      const p = s.pts[at];
      // An end repeats itself, which is how the shader is told there is no neighbour that way.
      const prev = s.pts[at === 0 ? 0 : at - 1];
      const next = s.pts[at === n - 1 ? n - 1 : at + 1];
      const px = mx(prev[0]), py = my(prev[1]);
      const cx = mx(p[0]), cy = my(p[1]);
      const nx = mx(next[0]), ny = my(next[1]);
      for (const side of [-1, 1]) {
        const o = v * LINE_STRIDE;
        vertices[o] = px; vertices[o + 1] = py;
        vertices[o + 2] = cx; vertices[o + 3] = cy;
        vertices[o + 4] = nx; vertices[o + 5] = ny;
        vertices[o + 6] = side;
        vertices[o + 7] = cap;
        vertices[o + 8] = s.cb; vertices[o + 9] = s.mb;
        vertices[o + 10] = cr; vertices[o + 11] = cg; vertices[o + 12] = cb;
        routeOf[v] = rid;
        v++;
      }
    };
    emit(0, -1);
    for (let k = 0; k < n; k++) emit(k, 0);
    emit(n - 1, 1);

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const pt of s.pts) {
      const x = mx(pt[0]), y = my(pt[1]);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const partStart = i;

    // Two triangles per gap between consecutive pairs — the caps included, which is what gives the
    // fragment stage the two pixels it needs to round an end off.
    for (let k = 0; k + 1 < n + 2; k++) {
      const a = base + k * 2;
      indices[i++] = a; indices[i++] = a + 1; indices[i++] = a + 2;
      indices[i++] = a + 1; indices[i++] = a + 3; indices[i++] = a + 2;
    }
    parts.push({ z: s.z, start: partStart, count: i - partStart, minX, minY, maxX, maxY });
    if (level >= 0 && level < WEAVE_LEVELS) levels[level].count = i - levels[level].start;
  }

  return {
    vertices, indices, levels, routeOf, routes, parts, vertexCount,
    bytes: vertices.byteLength + indices.byteLength + routeOf.byteLength,
  };
}
