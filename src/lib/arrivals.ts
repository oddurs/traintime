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
  /**
   * This train's run begins here — it is leaving, not arriving.
   *
   * At a terminal that is the only thing a rider can act on: the trains that pull in are ending
   * their runs, and the countdown that matters is the one to the next departure.
   */
  departing: boolean;
  /** When a destination is asked for: our predicted arrival there, and the ride length. */
  destEta?: number;
  rideSeconds?: number;
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
export function arrivalsAt(
  index: NetworkIndex,
  states: Iterable<TrainState>,
  station: string,
  limit = 6,
  /** Only trains that go on to serve this station, with the ride time worked out. */
  destination?: string,
): ArrivalGroup[] {
  // Match the whole complex: someone standing at Times Sq wants every train at Times Sq, not
  // only the ones on the platform GTFS happens to have keyed the station by.
  const target = new Set(index.complexStations(station));
  const to = destination ? new Set(index.complexStations(destination)) : undefined;
  const found: Arrival[] = [];
  for (const st of states) {
    // Neither a train that has not started nor one the feed has stopped updating belongs on a
    // board: both would be presented as something a rider could catch.
    if (st.phase === "unstarted" || st.stale) continue;
    // Fall back to where it is heading next if the run's end is not a nameable station.
    const dest = st.destination ?? st.nextStop;
    if (st.phase === "dwelling" && target.has(parentOf(st.nextStop))) {
      let destEta: number | undefined;
      if (to) {
        const d = st.stops.find((x) => to.has(parentOf(x.id)));
        if (!d) continue;
        destEta = d.eta;
      }
      const eta = st.arrivedAt ?? st.eta;
      found.push({
        id: st.id, route: st.route, direction: st.direction, eta, etaRaw: st.etaRaw,
        sigma: 0, destination: dest, stopsAway: 0, atPlatform: true,
        departing: st.stops.length > 1 && target.has(parentOf(st.stops[0].id)),
        destEta, rideSeconds: destEta === undefined ? undefined : destEta - eta,
        state: st,
      });
      continue;
    }
    const idx = st.stops.findIndex((s) => target.has(parentOf(s.id)));
    if (idx === -1) continue;
    const s = st.stops[idx];
    // A trip only counts if this train reaches the destination after the boarding stop; our own
    // per-stop predictions already carry the arrival time there, so no second model is needed.
    let destEta: number | undefined;
    if (to) {
      const dIdx = st.stops.findIndex((x, i) => i > idx && to.has(parentOf(x.id)));
      if (dIdx === -1) continue;
      destEta = st.stops[dIdx].eta;
    }
    found.push({
      id: st.id, route: st.route, direction: st.direction, eta: s.eta, etaRaw: s.etaRaw, sigma: s.sigma,
      destination: dest, stopsAway: idx, atPlatform: false, departing: idx === 0 && st.prevStop === undefined && st.stops.length > 1,
      destEta, rideSeconds: destEta === undefined ? undefined : destEta - s.eta,
      state: st,
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

/**
 * Stations whose name matches, ranked by how early and completely it matches, and collapsed to
 * one result per complex — five "Times Sq" rows would be five ways of saying the same thing.
 */
export function searchStations(index: NetworkIndex, query: string, limit = 8) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const best = new Map<string, { id: string; name: string; routes: string[]; score: number }>();
  for (const s of Object.values(index.net.stations)) {
    const name = s.name.toLowerCase();
    const at = name.indexOf(q);
    if (at === -1) continue;
    const wordStart = at === 0 || /[^a-z0-9]/.test(name[at - 1]);
    const key = index.complexKey(s.id);
    const entry = {
      id: key,
      name: index.complexName(s.id),
      routes: index.complexRoutes(s.id),
      score: (wordStart ? 0 : 50) + at + name.length / 100,
    };
    const cur = best.get(key);
    if (!cur || entry.score < cur.score) best.set(key, entry);
  }
  return [...best.values()].sort((a, b) => a.score - b.score).slice(0, limit);
}

/** Complexes nearest a point, closest first — the nearest place to catch a train. */
export function nearestStations(index: NetworkIndex, lat: number, lon: number, limit = 5) {
  const cos = Math.cos((lat * Math.PI) / 180);
  const best = new Map<string, { id: string; name: string; routes: string[]; meters: number }>();
  for (const s of Object.values(index.net.stations)) {
    const meters = Math.hypot((s.lon - lon) * 111_320 * cos, (s.lat - lat) * 111_320);
    const key = index.complexKey(s.id);
    const cur = best.get(key);
    if (!cur || meters < cur.meters) {
      best.set(key, { id: key, name: index.complexName(s.id), routes: index.complexRoutes(s.id), meters });
    }
  }
  return [...best.values()].sort((a, b) => a.meters - b.meters).slice(0, limit);
}
