import type { LonLat } from "./types";

const M_PER_DEG_LAT = 111_320;

/** Planar distance in metres; fine at city scale. */
export function distM(a: LonLat, b: LonLat): number {
  const cos = Math.cos(((a[1] + b[1]) / 2) * (Math.PI / 180));
  const dx = (b[0] - a[0]) * M_PER_DEG_LAT * cos;
  const dy = (b[1] - a[1]) * M_PER_DEG_LAT;
  return Math.hypot(dx, dy);
}

/**
 * Shift a polyline sideways by `metres`, positive to the right of the direction of travel.
 * Doing this to the geometry — rather than asking the renderer for a pixel offset — means the
 * lane is a property of the track itself, so a train and its line agree at every zoom and the
 * result cannot depend on which way round a line happened to be drawn.
 */
/**
 * How much of a corner's radius an offset may eat into before it is held back. Offsetting a
 * polyline towards the inside of a bend by more than the bend's own radius turns the curve inside
 * out: the inner bands of a bundle loop back through each other and the corridor comes out as a
 * knot. Holding the inside bands short of the centre of the turn keeps the bundle nested.
 */
const CORNER_LIMIT = 0.7;

/** East/north metres per degree at a given latitude, for local flat-earth arithmetic. */
const local = (lat: number) => {
  const cos = Math.cos((lat * Math.PI) / 180) || 1e-6;
  return { cos, ex: M_PER_DEG_LAT * cos, ny: M_PER_DEG_LAT };
};

/**
 * Offset a polyline sideways by a distance that may vary along it. `at(i)` gives the offset in
 * metres at vertex i, positive to the right of travel.
 */
function offsetBy(pts: LonLat[], at: (i: number) => number): LonLat[] {
  const out: LonLat[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const { cos, ex, ny } = local(pts[i][1]);
    const east = (b[0] - a[0]) * cos, north = b[1] - a[1];
    const len = Math.hypot(east, north) || 1;
    let m = at(i);
    // Hold the offset back from the centre of a tight turn, or the curve inverts.
    if (i > 0 && i < pts.length - 1 && m !== 0) {
      const p = pts[i - 1], c = pts[i], q = pts[i + 1];
      const e1 = (c[0] - p[0]) * cos, n1 = c[1] - p[1];
      const e2 = (q[0] - c[0]) * cos, n2 = q[1] - c[1];
      const l1 = Math.hypot(e1, n1), l2 = Math.hypot(e2, n2);
      if (l1 > 0 && l2 > 0) {
        const cross = (e1 * n2 - n1 * e2) / (l1 * l2);
        const dot = (e1 * e2 + n1 * n2) / (l1 * l2);
        const turn = Math.atan2(cross, dot);
        // A right turn (clockwise, negative here) puts the inside on the right, where a positive
        // offset goes. Only the band on the inside of the bend is at risk.
        const inside = (turn < 0 && m > 0) || (turn > 0 && m < 0);
        if (inside && Math.abs(turn) > 1e-3) {
          const half = (Math.min(l1, l2) * M_PER_DEG_LAT) / 2;
          const radius = half / Math.tan(Math.abs(turn) / 2);
          const cap = CORNER_LIMIT * radius;
          if (Math.abs(m) > cap) m = Math.sign(m) * cap;
        }
      }
    }
    out.push([pts[i][0] + ((north / len) * m) / ex, pts[i][1] + ((-east / len) * m) / ny]);
  }
  return out;
}

export function offsetPolyline(pts: LonLat[], metres: number): LonLat[] {
  if (metres === 0 || pts.length < 2) return pts;
  return offsetBy(pts, () => metres);
}

export interface Path {
  pts: LonLat[];
  /** Cumulative metres at each vertex. */
  cum: number[];
  /** Total length in metres. */
  length: number;
}

export function makePath(pts: LonLat[]): Path {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + distM(pts[i - 1], pts[i]));
  return { pts, cum, length: cum[cum.length - 1] };
}

/** Compass bearing from a to b, degrees clockwise from north. */
export function bearingBetween(a: LonLat, b: LonLat): number {
  const cos = Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  const deg = (Math.atan2((b[0] - a[0]) * cos, b[1] - a[1]) * 180) / Math.PI;
  return (deg + 360) % 360;
}

/**
 * Heading of the track around distance s, measured across a window rather than from the single
 * polyline segment s happens to fall in — a vertex should not make the arrow snap.
 */
export function headingAt(path: Path, s: number, window = 26): number {
  if (path.length === 0) return 0;
  const a = alongPath(path, Math.max(0, s - window)).p;
  const b = alongPath(path, Math.min(path.length, s + window)).p;
  if (a[0] === b[0] && a[1] === b[1]) return alongPath(path, s).bearing;
  return bearingBetween(a, b);
}

/** Shortest-way interpolation between two compass bearings. */
export function lerpBearing(from: number, to: number, t: number): number {
  const delta = ((to - from + 540) % 360) - 180;
  return (from + delta * t + 360) % 360;
}

/** Point and heading (degrees clockwise from north) at distance s metres along the path. */
export function alongPath(path: Path, s: number): { p: LonLat; bearing: number } {
  const { pts, cum, length } = path;
  if (pts.length === 1 || length === 0) return { p: pts[0], bearing: 0 };
  const d = Math.max(0, Math.min(length, s));
  let i = 1;
  while (i < cum.length - 1 && cum[i] < d) i++;
  const a = pts[i - 1], b = pts[i];
  const segLen = cum[i] - cum[i - 1];
  const t = segLen === 0 ? 0 : (d - cum[i - 1]) / segLen;
  const p: LonLat = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const cos = Math.cos((a[1] * Math.PI) / 180);
  const bearing = (Math.atan2((b[0] - a[0]) * cos, b[1] - a[1]) * 180) / Math.PI;
  return { p, bearing: (bearing + 360) % 360 };
}

/** Vertices of the path between two distances, with interpolated end points. */
export function slicePath(path: Path, s0: number, s1: number): LonLat[] {
  const a = Math.max(0, Math.min(path.length, Math.min(s0, s1)));
  const b = Math.max(0, Math.min(path.length, Math.max(s0, s1)));
  const out: LonLat[] = [alongPath(path, a).p];
  for (let i = 0; i < path.pts.length; i++) if (path.cum[i] > a && path.cum[i] < b) out.push(path.pts[i]);
  out.push(alongPath(path, b).p);
  return out;
}

/**
 * Offset a polyline by an amount that varies along its length: `metres` through the middle, but
 * easing to `atStart` and `atEnd` at the two ends.
 *
 * This is what turns a change of band into a splay. Where a service moves from one band to the
 * next — because another service joined the corridor, or because it is leaving it — the two
 * segments either side of the station each ease halfway to meet the other, so the line sweeps
 * across instead of stepping sideways. Smoothstep rather than a straight ramp, because a linear
 * blend leaves a visible corner where it begins and ends.
 */
export function offsetPolylineRamped(pts: LonLat[], metres: number, atStart: number, atEnd: number, rampM: number): LonLat[] {
  if (pts.length < 2) return pts;
  if (atStart === metres && atEnd === metres) return offsetPolyline(pts, metres);
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + distM(pts[i - 1], pts[i]));
  const total = cum[cum.length - 1] || 1;
  // Never let the two ramps meet in the middle, or neither reaches the band it was aiming for.
  const ramp = Math.min(rampM, total / 2);
  const ease = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
  return offsetBy(pts, (i) => {
    const d = cum[i];
    if (d < ramp) return atStart + (metres - atStart) * ease(d / ramp);
    if (d > total - ramp) return metres + (atEnd - metres) * ease((d - (total - ramp)) / ramp);
    return metres;
  });
}
