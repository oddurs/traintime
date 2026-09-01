import type { LonLat, Network, Station } from "./types";
import { distM, makePath, offsetPolylineRamped, type Path } from "./geo";

export const parentOf = (id: string) => id.replace(/[NS]$/, "");

/**
 * Real spacing between adjacent track centres on the New York subway. The drawn geometry uses
 * the true figure, so zooming far enough in shows a four-track trunk laid out the way it is
 * actually built, and a train sits on the track it is actually on.
 */
export const TRACK_M = 4.6;
/** How far either side of a station a change of band is swept out. */
export const RAMP_M = 130;

/**
 * The extra separation, in screen pixels, added on top of the true track spacing — as two
 * separate curves, because two lines of different colours and two services sharing one are not
 * the same question.
 *
 * A colour is a line on any map of this system and stays apart at every zoom. The 4, 5 and 6 are
 * one green Lexington line until you are close enough to care which is which; below about zoom 14
 * they sit exactly on top of one another, and they part as you come in. That is what the printed
 * map does, and it is what stops a city-wide view from turning every trunk into a smear.
 *
 * Both curves fall to zero by zoom 19, where the true 4.6 m spacing in the geometry has grown past
 * ten pixels and is doing the whole job on its own.
 *
 * It has to be pixels rather than metres. Fanning by baking metres into the geometry means the fan
 * can only change by re-laying the network, which can only happen in steps — and the map visibly
 * jumped every time the zoom crossed one. As a paint property the renderer interpolates every
 * frame, so the bands ease apart and back together continuously.
 */
/**
 * How far apart two bands should look on screen, in pixels, whatever the zoom.
 *
 * A line and its casing are about six pixels wide, so anything under nine reads as a smear rather
 * than as two lines.
 */
const TARGET_PX = 11;
/**
 * Where same-colour services part company. Below this they sit exactly on top of one another and
 * a trunk reads as one line, the way the printed map draws it; above it they are fully separate.
 *
 * The window is deliberately narrow. Spread over three zoom levels, as it was, the 4, 5 and 6
 * spent the whole of the mid-range two to seven pixels apart — far enough to look wrong, not far
 * enough to read as three lines, with their casings touching. Over less than a zoom level it
 * reads as a deliberate reveal instead.
 */
const MERGE_BELOW = 13.4;
const SEPARATE_ABOVE = 14.2;

const smoothstep = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/**
 * The fan, derived rather than tabulated.
 *
 * The geometry already carries the true 4.6 m between track centres, which is worth a growing
 * number of pixels as you zoom in. What the fan adds is only ever the difference between that and
 * what the eye needs — so the total stays at the target instead of the two contributions being
 * tuned against each other by hand and drifting apart in the middle of the range.
 *
 * Past about zoom 18 the true spacing alone exceeds the target and the fan falls to nothing: the
 * lines then stand exactly where the track does, which is the right answer that close in.
 */
export function fanAt(zoom: number): { colour: number; service: number } {
  const geo = TRACK_M / metresPerPixel(zoom);
  const reveal = smoothstep((zoom - MERGE_BELOW) / (SEPARATE_ABOVE - MERGE_BELOW));
  return {
    colour: Math.max(0, TARGET_PX - geo),
    service: Math.max(0, TARGET_PX * reveal - geo),
  };
}

/** The zooms the renderer is given the curve at; between them it interpolates. */
const FAN_STOPS = [10, 12, 13, 13.4, 13.6, 13.8, 14, 14.2, 14.6, 15, 16, 17, 18, 19, 20];

/**
 * The renderer's version of the same curve, as a MapLibre expression giving a feature's offset.
 *
 * Sampled from `fanAt` rather than written out separately, so the lines and the trains cannot
 * drift apart: there is one curve and this is a reading of it.
 *
 * The zoom interpolation has to be the outermost expression — MapLibre rejects one nested inside
 * another and silently drops the layer when you try, which took most of the network off the map.
 * So each stop combines the feature's own two bands rather than the curve being multiplied whole.
 */
export function bandOffsetExpression(scale = 1): unknown[] {
  return [
    "interpolate", ["linear"], ["zoom"],
    ...FAN_STOPS.flatMap((z) => {
      const f = fanAt(z);
      return [z, ["+", ["*", ["get", "cb"], f.colour * scale], ["*", ["get", "sb"], f.service * scale]]];
    }),
  ];
}

/** Metres per pixel at New York's latitude. */
export const metresPerPixel = (zoom: number) => (156_543.03 * Math.cos((40.73 * Math.PI) / 180)) / 2 ** zoom;

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
  readonly stats = { paths: 0, chained: 0, straightFallback: 0 };
  /**
   * The signed band a train is riding, in the frame the drawn line is offset in.
   *
   * The line is offset to the right of the direction it happens to be drawn; a train is placed
   * relative to the direction it is travelling. These are the same side only when the two agree,
   * so the sign is resolved here once, and the map applies the identical number to both.
   */
  lateralBand(route: string, prevDir: string, nextDir: string): { cb: number; sb: number } | undefined {
    const a = parentOf(prevDir), b = parentOf(nextDir);
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    const parts = this.net.bandParts?.[key]?.[route];
    if (!parts) return undefined;
    const side = (this.net.segDir?.[key] ?? 1) * (a < b ? 1 : -1);
    return { cb: parts[0] * side, sb: parts[1] * side };
  }

  constructor(public readonly net: Network) {
    for (const m of Object.values(net.prevOf)) {
      for (const [k, v] of Object.entries(m)) {
        this.mergedPrev[k] = [...new Set([...(this.mergedPrev[k] ?? []), ...v])];
      }
    }
  }

  /**
   * One stretch of one service, laid into its band — the single source of truth for where that
   * service is drawn and where its trains ride. Lines and trains used to compute this separately
   * and disagree: a train sat 6 m off its own line normally and 9 m off it once the view was
   * narrowed, which is exactly the "not centred on the line it belongs to" the map showed.
   *
   * Returned in the segment's canonical (u < v) order; callers reverse it if they need the other.
   */
  private laid(route: string, key: string): LonLat[] | undefined {
    const pts = this.net.segments[key];
    if (!pts) return undefined;
    const ck = `${route}|${key}`;
    let out = this.lineCache.get(ck);
    if (!out) {
      const band = this.net.segmentSlots[key]?.[route]?.[0] ?? 0;
      const [u, v] = this.net.laneEnds?.[key]?.[route] ?? [band, band];
      // The band is measured in the corridor's own direction; this segment's points may be
      // stored the other way round, in which case the whole offset flips with them.
      const m = TRACK_M * (this.net.segDir?.[key] ?? 1);
      out = offsetPolylineRamped(pts, band * m, u * m, v * m, RAMP_M);
      this.lineCache.set(ck, out);
    }
    return out;
  }

  /**
   * Where a train of this route stands when it is at this platform.
   *
   * Not the station's coordinate: that is the middle of the corridor, and a service is drawn in
   * its own band beside it. Taking the end of the route's own drawn stretch puts a standing train
   * exactly where its line is — measured, dwelling trains were sitting a median 2.3 m and up to
   * 9.2 m off the track they belong to, which is one to two bands and plainly visible close in.
   */
  platformPoint(route: string, stopId: string): LonLat | undefined {
    const station = parentOf(stopId);
    for (const key of this.net.routeSegments[route] ?? []) {
      const [a, b] = key.split("-");
      if (a !== station && b !== station) continue;
      const laid = this.laid(route, key);
      if (!laid?.length) continue;
      return a === station ? laid[0] : laid[laid.length - 1];
    }
    return undefined;
  }

  /** Coordinates for one stretch as drawn. */
  lineSegment(route: string, u: string, v: string): LonLat[] | undefined {
    const key = u < v ? `${u}-${v}` : `${v}-${u}`;
    const laid = this.laid(route, key);
    if (!laid) return undefined;
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
      const laid = this.laid(route, key);
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
