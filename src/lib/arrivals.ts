import type { Direction, TrainState } from "./types";
import { parentOf, type NetworkIndex } from "./network";

export interface Arrival {
  /** Trip id of the arriving train. */
  id: string;
  route: string;
  direction: Direction;
  /** Our corrected arrival time, and the MTA's raw prediction. */
  eta: number;
  etaRaw: number;
  sigma: number;
  /** Terminal this train is headed to. */
  destination: string;
  /** How many stops before this one the train still has to make. */
  stopsAway: number;
  atPlatform: boolean;
  state: TrainState;
}

export interface ArrivalGroup {
  direction: Direction;
  /** The most common destination among the listed trains, as a human label. */
  label: string;
  arrivals: Arrival[];
}

/**
 * Everything approaching one station, from the same train states the map draws — so the board
 * and the map can never disagree.
 */
export function arrivalsAt(index: NetworkIndex, states: Iterable<TrainState>, station: string, limit = 6): ArrivalGroup[] {
  const target = parentOf(station);
  const found: Arrival[] = [];
  for (const st of states) {
    if (st.phase === "unstarted") continue;
    const dest = st.destination ?? (st.stops.length ? st.stops[st.stops.length - 1].id : st.nextStop);
    if (st.phase === "dwelling" && parentOf(st.nextStop) === target) {
      found.push({
        id: st.id, route: st.route, direction: st.direction, eta: st.arrivedAt ?? st.eta, etaRaw: st.etaRaw,
        sigma: 0, destination: dest, stopsAway: 0, atPlatform: true, state: st,
      });
      continue;
    }
    const idx = st.stops.findIndex((s) => parentOf(s.id) === target);
    if (idx === -1) continue;
    const s = st.stops[idx];
    found.push({
      id: st.id, route: st.route, direction: st.direction, eta: s.eta, etaRaw: s.etaRaw, sigma: s.sigma,
      destination: dest, stopsAway: idx, atPlatform: false, state: st,
    });
  }
  found.sort((a, b) => a.eta - b.eta);

  const groups: ArrivalGroup[] = [];
  for (const dir of ["N", "S"] as Direction[]) {
    const arrivals = found.filter((a) => a.direction === dir).slice(0, limit);
    if (arrivals.length === 0) continue;
    const counts = new Map<string, number>();
    for (const a of arrivals) counts.set(a.destination, (counts.get(a.destination) ?? 0) + 1);
    const top = [...counts.entries()].sort((x, y) => y[1] - x[1])[0][0];
    groups.push({ direction: dir, label: index.stationName(top), arrivals });
  }
  return groups;
}

/** Stations whose name matches a query, ranked by how early and how completely it matches. */
export function searchStations(index: NetworkIndex, query: string, limit = 8) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored: { id: string; name: string; routes: string[]; score: number }[] = [];
  for (const s of Object.values(index.net.stations)) {
    const name = s.name.toLowerCase();
    const at = name.indexOf(q);
    if (at === -1) continue;
    const wordStart = at === 0 || /[^a-z0-9]/.test(name[at - 1]);
    scored.push({
      id: s.id, name: s.name, routes: index.net.stationRoutes[s.id] ?? [],
      score: (wordStart ? 0 : 50) + at + name.length / 100,
    });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, limit);
}

/** Stations nearest a point, closest first. */
export function nearestStations(index: NetworkIndex, lat: number, lon: number, limit = 5) {
  const cos = Math.cos((lat * Math.PI) / 180);
  return Object.values(index.net.stations)
    .map((s) => ({
      id: s.id, name: s.name, routes: index.net.stationRoutes[s.id] ?? [],
      meters: Math.hypot((s.lon - lon) * 111_320 * cos, (s.lat - lat) * 111_320),
    }))
    .sort((a, b) => a.meters - b.meters)
    .slice(0, limit);
}
