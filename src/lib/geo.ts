import type { LonLat } from "./types";

const M_PER_DEG_LAT = 111_320;

/** Planar distance in metres; fine at city scale. */
export function distM(a: LonLat, b: LonLat): number {
  const cos = Math.cos(((a[1] + b[1]) / 2) * (Math.PI / 180));
  const dx = (b[0] - a[0]) * M_PER_DEG_LAT * cos;
  const dy = (b[1] - a[1]) * M_PER_DEG_LAT;
  return Math.hypot(dx, dy);
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
