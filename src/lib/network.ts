import type { LonLat, Network, Station } from "./types";
import { distM, makePath, type Path } from "./geo";
import { PALETTE } from "./palette";
import { LineEngine } from "./layout";

export const parentOf = (id: string) => id.replace(/[NS]$/, "");

/** How much of the run-in to a platform stands in for a journey we cannot trace. */
const APPROACH_M = 400;

// Drawing lives in ./layout. Re-exported so a caller has one import for the map.
export { TRACK_M, RAMP_M, fanAt, metresPerPixel, lineWidthAt, casingWidthAt, LineEngine, type Stroke } from "./layout";

/** Indexed, query-friendly view of network.json shared by server and client. */
export class NetworkIndex {
  private pathCache = new Map<string, Path>();
  private segCache = new Map<string, Path>();
  private lineCache = new Map<string, LonLat[]>();
  private mergedPrev: Record<string, string[]> = {};
  private terminals: Map<string, string[]> | null = null;

  /**
   * The services for which this station is the end of the line.
   *
   * A terminal is a different place from a stop and the map should say so: the line ends there,
   * trains lay over rather than dwell, and what a rider wants is a departure rather than an
   * arrival. Eighty of the system's stations are one, and eighteen are the terminal for more than
   * one service.
   */
  terminalFor(station: string): string[] {
    if (!this.terminals) {
      this.terminals = new Map();
      for (const [shape, stops] of Object.entries(this.net.shapeStops)) {
        const route = shape.split(/[._]/)[0];
        for (const end of [stops[0], stops[stops.length - 1]]) {
          if (!end) continue;
          const p = parentOf(end);
          const list = this.terminals.get(p) ?? this.terminals.set(p, []).get(p)!;
          if (!list.includes(route)) list.push(route);
        }
      }
    }
    return this.terminals.get(parentOf(station)) ?? [];
  }

  /**
   * How many services a rider can catch here, counting the whole complex — "Times Sq" is thirteen
   * routes across five GTFS stations, and the map should draw it as the interchange it is.
   */
  servesCount(station: string): number {
    const members = this.complexStations(parentOf(station));
    const seen = new Set<string>();
    for (const m of members) for (const r of this.net.stationRoutes[m] ?? []) seen.add(r);
    return seen.size;
  }

  /** Diagnostics: how often we had to guess a train's track instead of knowing it. */
  /**
   * What it took to answer "where is this train".
   *
   * `untraceable` is a pair the route graph cannot walk between; `straightFallback` is the subset
   * of those where even the approach to the next platform was unavailable and a line had to be
   * invented. They were one counter, which reported the first number and was read as the second.
   */
  readonly stats = { paths: 0, chained: 0, untraceable: 0, straightFallback: 0 };

  /** How the network is drawn: bands, the fan, and the geometry that follows from them. */
  readonly lines: LineEngine;

  /** Where this service is drawn between two stops. */
  lineSegment(route: string, u: string, v: string) { return this.lines.lineSegment(route, u, v); }
  /** The same, with the band each point sits on, so a renderer can keep its offset in step. */
  lineSegmentBands(route: string, u: string, v: string) { return this.lines.lineSegmentBands(route, u, v); }
  /** Every stroke the map draws, cut so its screen offset can follow its geometry. */
  strokes() { return this.lines.strokes(); }
  /** Where a train of this service stands at this platform, on its own band. */
  platformPoint(route: string, stopId: string) { return this.lines.platformPoint(route, stopId); }
  /** The signed band a train is riding, in the frame the drawn line is offset in. */
  lateralBand(route: string, prevDir: string, nextDir: string, along?: number) { return this.lines.lateralBand(route, prevDir, nextDir, along); }
  constructor(public readonly net: Network) {
    this.lines = new LineEngine(net);
    for (const m of Object.values(net.prevOf)) {
      for (const [k, v] of Object.entries(m)) {
        this.mergedPrev[k] = [...new Set([...(this.mergedPrev[k] ?? []), ...v])];
      }
    }
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

  /** The emblem colour: what a bullet is printed in. */
  routeColor(route: string): string {
    return this.net.routes[route]?.color ?? PALETTE["--route-unknown"];
  }

  /** What this service's line is drawn in on the map's black ground. */
  routeLineColor(route: string): string {
    return this.net.routes[route]?.lineColor ?? this.routeColor(route);
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
      const laid = this.lines.lineSegment(route, a < b ? a : b, a < b ? b : a);
      if (!laid) return undefined;
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
      /*
       * No track between these two, and no way to chain there through the route's own graph.
       *
       * The feed does report this: a trip whose intermediate stops have been dropped, or a train
       * put on a pattern the schedule has never seen, and then "the stop before" and "the stop
       * next" are twenty stations apart. Joining them with a straight line drew a B from 81 St to
       * DeKalb Av — ten kilometres across Manhattan, through Central Park, on track that does not
       * exist — with a marker sliding merrily along it.
       *
       * What is actually known is the stop it is heading for, so the train is put on the final
       * approach to that platform instead. It is on its own line, at a place it will really be,
       * and the countdown beside it is unaffected.
       */
      this.stats.untraceable++;
      const approach = this.approachTo(route, nextDir);
      if (!approach) this.stats.straightFallback++;
      path = approach ?? this.straightLine(pa, pb);
    }
    this.pathCache.set(key, path);
    return path;
  }

  /**
   * The last stretch of track into a platform, as a path a train can be placed on.
   *
   * Long enough that a marker approaching it has somewhere to move, short enough that it says
   * nothing about where the train came from — which, in the cases this is for, we do not know.
   */
  private approachTo(route: string, nextDir: string): Path | undefined {
    const next = parentOf(nextDir);
    for (const key of this.net.routeSegments[route] ?? []) {
      const [a, b] = key.split("-");
      if (a !== next && b !== next) continue;
      const from = a === next ? b : a;
      const seg = this.lines.lineSegment(route, from, next);
      if (!seg || seg.length < 2) continue;
      const pts: LonLat[] = [seg[seg.length - 1]];
      let run = 0;
      for (let i = seg.length - 2; i >= 0 && run < APPROACH_M; i--) {
        run += distM(seg[i], seg[i + 1]);
        pts.unshift(seg[i]);
      }
      if (pts.length >= 2) return makePath(pts);
    }
    return undefined;
  }

  private straightLine(pa: string, pb: string): Path {
    const a = this.station(pa), b = this.station(pb);
    const pa_: LonLat = a ? [a.lon, a.lat] : [0, 0];
    const pb_: LonLat = b ? [b.lon, b.lat] : pa_;
    return makePath([pa_, pb_]);
  }

  /** Walk backwards from next through the route's predecessor graph looking for prev. */
  private findChain(route: string, prevDir: string, nextDir: string): string[] | undefined {
    const graph = this.net.prevOf[route] ?? this.mergedPrev;
    const back = new Map<string, string>();
    let frontier = [nextDir];
    const visited = new Set(frontier);
    for (let depth = 0; depth < 24 && frontier.length; depth++) {
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
