import type { LonLat, Network, Station } from "./types";
import { distM, makePath, offsetPolyline, type Path } from "./geo";

export const parentOf = (id: string) => id.replace(/[NS]$/, "");

/**
 * Lane geometry. Real adjacent tracks are about 4 m apart, which is invisible at any zoom you
 * would actually look at a city map through, so these are schematic: wide enough to read, and
 * applied to the geometry so a train and its line can never disagree.
 */
export const LANE_M = 18;
export const TRACK_M = 6;
/** How far apart same-colour services are drawn once the view is narrowed to a few of them. */
export const SPLIT_M = 15;

/**
 * How lines are laid out. Showing everything, services that share a trunk share a lane, because
 * that is what the system map does and what the colour means. Narrow the view to two services and
 * that convention hides one of them, so each visible route takes its own lane instead.
 */
export type LaneMode = "trunk" | "route";

/** Indexed, query-friendly view of network.json shared by server and client. */
export class NetworkIndex {
  private pathCache = new Map<string, Path>();
  private segCache = new Map<string, Path>();
  private lineCache = new Map<string, LonLat[]>();
  private mergedPrev: Record<string, string[]> = {};
  /** Diagnostics: how often we had to guess a train's track instead of knowing it. */
  readonly stats = { paths: 0, chained: 0, straightFallback: 0 };

  constructor(public readonly net: Network) {
    for (const m of Object.values(net.prevOf)) {
      for (const [k, v] of Object.entries(m)) {
        this.mergedPrev[k] = [...new Set([...(this.mergedPrev[k] ?? []), ...v])];
      }
    }
  }

  /**
   * How far this route's track sits from the corridor centreline, in metres. Lines use the
   * colour lane only (the trunk); trains additionally take their own track within it, so the
   * 4, 5 and 6 do not stack on top of each other under Lexington Avenue.
   */
  laneMetres(route: string, key: string, includeTrack: boolean): number {
    const lane = this.net.segmentSlots[key]?.[route]?.[0] ?? 0;
    const track = includeTrack ? this.net.trackSlots?.[key]?.[route]?.[0] ?? 0 : 0;
    return lane * LANE_M + track * TRACK_M;
  }

  /** Coordinates for one stretch as drawn, offset into its lane. */
  lineSegment(route: string, u: string, v: string, mode: LaneMode = "trunk"): LonLat[] | undefined {
    const key = u < v ? `${u}-${v}` : `${v}-${u}`;
    const pts = this.net.segments[key];
    if (!pts) return undefined;
    const ck = `${mode}|${route}|${key}`;
    let laid = this.lineCache.get(ck);
    if (!laid) {
      const lane = this.net.segmentSlots[key]?.[route]?.[0] ?? 0;
      const track = this.net.trackSlots?.[key]?.[route]?.[0] ?? 0;
      const metres = mode === "route" ? lane * LANE_M + track * SPLIT_M : lane * LANE_M;
      laid = offsetPolyline(pts, metres);
      this.lineCache.set(ck, laid);
    }
    return u < v ? laid : [...laid].reverse();
  }

  /** The complex a station belongs to — what a rider means when they name a station. */
  complexKey(id: string): string {
    const p = parentOf(id);
    return this.net.complexOf?.[p] ?? p;
  }

  /** Every GTFS station a rider would call by this name. */
  complexStations(id: string): string[] {
    const key = this.complexKey(id);
    return this.net.complexes?.[key]?.stations ?? [parentOf(id)];
  }

  complexName(id: string): string {
    const key = this.complexKey(id);
    return this.net.complexes?.[key]?.name ?? this.stationName(id);
  }

  complexRoutes(id: string): string[] {
    const key = this.complexKey(id);
    return this.net.complexes?.[key]?.routes ?? this.net.stationRoutes[parentOf(id)] ?? [];
  }

  station(id: string): Station | undefined {
    return this.net.stations[parentOf(id)];
  }

  stationName(id: string): string {
    return this.station(id)?.name ?? id;
  }

  routeColor(route: string): string {
    return this.net.routes[route]?.color ?? "#808183";
  }

  /**
   * The stop before `nextDir` on this trip's own scheduled pattern, from the shape encoded in its
   * GTFS trip id. Three outcomes worth telling apart: an exact predecessor; "origin", meaning the
   * next stop is where this run begins so there is genuinely nothing before it; and "unknown",
   * meaning the schedule has no such shape (the realtime feed carries supplement trips the static
   * file has not caught up with) and we must fall back to guessing.
   */
  scheduledPrev(tripId: string, nextDir: string): { kind: "stop"; id: string } | { kind: "origin" } | { kind: "unknown" } {
    const shape = tripId.slice(tripId.indexOf("_") + 1);
    const stops = this.net.shapeStops?.[shape];
    if (!stops) return { kind: "unknown" };
    const i = stops.indexOf(nextDir);
    if (i > 0) return { kind: "stop", id: stops[i - 1] };
    if (i === 0) return { kind: "origin" };
    return { kind: "unknown" };
  }

  /**
   * Candidate previous stops for `nextDir` on `route`. Strictly this route's own: services share
   * track, but they do not share stop patterns, and borrowing a neighbour's predecessor is how a
   * G ends up drawn on the F's tracks past its own terminal. If this route has no predecessor for
   * the stop — it is a terminal, or the run is a reroute — the honest answer is "we do not know".
   */
  prevCandidates(route: string, nextDir: string): string[] {
    const own = this.net.prevOf[route]?.[nextDir];
    if (own?.length) return own;
    // Only when this route's own pattern has nothing to say: the physical network still connects
    // these stops, and a plausible neighbour beats leaving the train parked at a station.
    return this.mergedPrev[nextDir] ?? [];
  }

  /** Straight-line metres between two stops. */
  hop(a: string, b: string): number {
    const sa = this.station(a), sb = this.station(b);
    return sa && sb ? distM([sa.lon, sa.lat], [sb.lon, sb.lat]) : Infinity;
  }

  /** Scheduled run time between two stops, if the pair is scheduled consecutively. */
  scheduledRun(prevDir: string, nextDir: string): number | undefined {
    const a = parentOf(prevDir), b = parentOf(nextDir);
    return this.net.schedRun[a < b ? `${a}-${b}` : `${b}-${a}`];
  }

  /** The track a train of this route actually runs on, as a measurable path. */
  private segment(a: string, b: string, route: string): Path | undefined {
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    const pts = this.net.segments[key];
    if (!pts) return undefined;
    const ck = `${route}|${a}-${b}`;
    let p = this.segCache.get(ck);
    if (!p) {
      const laid = offsetPolyline(pts, this.laneMetres(route, key, true));
      p = makePath(a < b ? laid : [...laid].reverse());
      this.segCache.set(ck, p);
    }
    return p;
  }

  /** Track geometry from prev to next, chaining through skipped stops if needed. */
  pathBetween(route: string, prevDir: string, nextDir: string): Path {
    const key = `${route}|${prevDir}|${nextDir}`;
    const cached = this.pathCache.get(key);
    if (cached) return cached;
    this.stats.paths++;
    const pa = parentOf(prevDir), pb = parentOf(nextDir);
    let path = this.segment(pa, pb, route);
    if (!path) {
      this.stats.chained++;
      const chain = this.findChain(route, prevDir, nextDir);
      if (chain) {
        const pts: LonLat[] = [];
        let ok = true;
        for (let i = 0; i + 1 < chain.length; i++) {
          const seg = this.segment(parentOf(chain[i]), parentOf(chain[i + 1]), route);
          if (!seg) { ok = false; break; }
          pts.push(...(pts.length ? seg.pts.slice(1) : seg.pts));
        }
        if (ok && pts.length >= 2) path = makePath(pts);
      }
    }
    if (!path) {
      this.stats.straightFallback++;
      const a = this.station(pa), b = this.station(pb);
      const pa_: LonLat = a ? [a.lon, a.lat] : [0, 0];
      const pb_: LonLat = b ? [b.lon, b.lat] : pa_;
      path = makePath([pa_, pb_]);
    }
    this.pathCache.set(key, path);
    return path;
  }

  /** Walk backwards from next through the route's predecessor graph looking for prev. */
  private findChain(route: string, prevDir: string, nextDir: string): string[] | undefined {
    const graph = this.net.prevOf[route] ?? this.mergedPrev;
    const back = new Map<string, string>();
    let frontier = [nextDir];
    const visited = new Set(frontier);
    for (let depth = 0; depth < 10 && frontier.length; depth++) {
      const nextFrontier: string[] = [];
      for (const cur of frontier) {
        for (const p of graph[cur] ?? this.mergedPrev[cur] ?? []) {
          if (visited.has(p)) continue;
          visited.add(p);
          back.set(p, cur);
          if (p === prevDir) {
            const chain = [p];
            let c = p;
            while (c !== nextDir) { c = back.get(c)!; chain.push(c); }
            return chain;
          }
          nextFrontier.push(p);
        }
      }
      frontier = nextFrontier;
    }
    return undefined;
  }
}
