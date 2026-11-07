import type { TrainState } from "./types";
import type { NetworkIndex } from "./network";
import { arrivalsAt, type Arrival } from "./arrivals";
import { WALK_MPS, walkSeconds } from "./places";

/**
 * The walking radii a rider can choose, in minutes on foot.
 *
 * Minutes rather than metres, because that is how anyone decides whether a station is "near":
 * nobody knows what 800 m looks like from a street corner, everybody knows what ten minutes feels
 * like. The radius in metres is derived from the same pace the board uses for "about N min walk".
 */
export const RADII_MIN = [5, 10, 20] as const;
export type RadiusMin = (typeof RADII_MIN)[number];

/**
 * The straight-line radius that a walk of `minutes` covers.
 *
 * The inverse of `walkSeconds`: the same detour factor and the same allowance for stairs, so a
 * station listed inside the ten-minute radius is one the board then says is about ten minutes away.
 */
export function radiusMetres(minutes: number): number {
  return Math.max(0, ((minutes * 60 - 45) * WALK_MPS) / 1.3);
}

export interface NearbyStation {
  id: string;
  name: string;
  routes: string[];
  meters: number;
  walkSeconds: number;
  /** The next trains from here, either direction, soonest first. */
  arrivals: Arrival[];
}

/** Enough stations to cover a busy corner of Manhattan without the list becoming the whole sheet. */
const MAX_STATIONS = 6;

/**
 * The stations within walking distance, closest first, each with its next few trains.
 *
 * One complex is one station here, as it is on the board: Times Sq is one place to walk to, not
 * four platforms. A station with nothing approaching is still listed, because that it is quiet is
 * an answer. The order is distance alone: it is the order a rider would walk to them.
 */
export function nearbyStations(
  index: NetworkIndex,
  trains: Iterable<TrainState>,
  lat: number,
  lon: number,
  radiusM: number,
  perStation = 3,
  maxStations = MAX_STATIONS,
): NearbyStation[] {
  const cos = Math.cos((lat * Math.PI) / 180);
  const best = new Map<string, { id: string; name: string; routes: string[]; meters: number }>();
  for (const s of Object.values(index.net.stations)) {
    const meters = Math.hypot((s.lon - lon) * 111_320 * cos, (s.lat - lat) * 111_320);
    if (meters > radiusM) continue;
    const key = index.complexKey(s.id);
    const cur = best.get(key);
    if (!cur || meters < cur.meters) {
      best.set(key, { id: key, name: index.complexName(s.id), routes: index.complexRoutes(s.id), meters });
    }
  }
  const list = [...trains];
  return [...best.values()]
    .sort((a, b) => a.meters - b.meters)
    .slice(0, maxStations)
    .map((s) => ({
      ...s,
      walkSeconds: walkSeconds(s.meters),
      arrivals: arrivalsAt(index, list, s.id, perStation)
        .flatMap((g) => g.arrivals)
        .sort((a, b) => a.eta - b.eta)
        .slice(0, perStation),
    }));
}
