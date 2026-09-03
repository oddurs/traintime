/**
 * The line engine: how the network is drawn.
 *
 * Every service sharing a right of way gets its own band beside the others, and this decides
 * where each band goes. It has one contract, and `npm run audit:layout` checks every clause:
 *
 *  - **Ordered.** Two services keep the same left-to-right order everywhere they meet. A pair
 *    never swaps sides for no reason, because a rider learns positions.
 *  - **Separated and conjoined.** A service joining or leaving a corridor sweeps into its band
 *    across the station rather than stepping sideways, and the strokes either side meet.
 *  - **The ends join.** Where two strokes of one service meet they are drawn in the same place —
 *    on screen, not just in the data. Sharing a coordinate is not enough: `line-offset` moves a
 *    whole feature sideways in pixels, so two strokes can meet exactly in the geometry and still
 *    be drawn a finger's width apart, which is what a line looks like when it stops dead in the
 *    middle of the map instead of carrying on.
 *  - **Intertwined.** Where bands cross, one passes over: bands further right always draw above
 *    bands further left, so a pair never weaves one way here and the other way there.
 *  - **Proportioned.** Two lines sit the same distance apart on screen at every zoom, because the
 *    fan is what the eye needs *minus* what the true track spacing already provides. Measured
 *    between two services, never one curve at a time — that is how the geometry and the screen
 *    offset came to be ordered differently while each looked right on its own.
 *  - **One line when far away.** Services sharing a trunk colour collapse onto each other below
 *    zoom 13.4 — the 4, 5 and 6 are one green Lexington line on a city-wide view.
 *  - **Trains on their own track.** A train is placed by these same numbers, so it cannot sit
 *    beside the line it runs on, standing or moving.
 *  - **Cheap.** The whole network lays out in a few milliseconds, once, and is then cached.
 *
 * Which band a service occupies, which way each stretch runs, and the eased ends are decided once
 * at build time in scripts/build-network.ts and read from network.json here. This module turns
 * those decisions into coordinates.
 */
import type { LonLat, Network } from "./types";
import { distM, offsetPolylineRamped } from "./geo";
import { trunkOf } from "./trunks";

const parentOf = (id: string) => id.replace(/[NS]$/, "");

/**
 * Real spacing between adjacent track centres on the New York subway. The drawn geometry uses the
 * true figure, so zooming far enough in shows a four-track trunk laid out the way it is actually
 * built, and a train sits on the track it is actually on.
 */
export const TRACK_M = 4.6;
/** How far either side of a station a change of band is swept out. */
export const RAMP_M = 130;

/**
 * How far apart two bands should look on screen, in pixels, whatever the zoom. A line and its
 * casing are about six pixels wide, so anything under nine reads as a smear rather than two lines.
 */
const TARGET_PX = 11;
/**
 * Where same-colour services part company. Below this they sit exactly on top of one another and
 * a trunk reads as one line, the way the printed map draws it; above it they are fully separate.
 *
 * The window is deliberately narrow. Spread over three zoom levels, as it once was, the 4, 5 and
 * 6 spent the whole mid-range two to seven pixels apart — far enough to look wrong, not far
 * enough to read as three lines, with their casings touching. Over less than a zoom level it
 * reads as a deliberate reveal instead.
 */
const MERGE_BELOW = 13.4;
const SEPARATE_ABOVE = 14.2;

const smoothstep = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/**
 * How far a stroke's band may drift from the value it is drawn with, in bands.
 *
 * A band is eleven pixels through the zooms that matter, so a sixteenth of one is about 0.7 px —
 * a fifth of the width of the line itself, and invisible against a round join. Each piece is drawn
 * at the mean of the bands it spans, so this bounds both the step between two pieces of one stroke
 * and the gap where two strokes meet. Coarser and a splay reads as a staircase; finer and the
 * feature count climbs for nothing.
 */
const BAND_STEP = 1 / 16;

/**
 * How close two stretches have to meet before the join is treated as one point.
 *
 * They are laid out separately and ease into a shared band from either side, which closes to
 * within a third of a metre — near enough to draw, far enough that keeping both points puts a
 * step backwards in the middle of a curve.
 */
const JOIN_M = 1.5;

/** One drawn piece of one service: geometry, and the band the renderer should offset it by. */
export interface Stroke {
  route: string;
  colour: string;
  /** Which run it came from, so a caller can tell a cut within a stroke from a join between two. */
  run: string;
  /** Whether this piece carries the start or the end of its run — where a real join can happen. */
  first: boolean;
  last: boolean;
  slot: number;
  shared: number;
  z: number;
  cb: number;
  mb: number;
  pts: LonLat[];
}

/** Metres per pixel at New York's latitude. */
export const metresPerPixel = (zoom: number) => (156_543.03 * Math.cos((40.73 * Math.PI) / 180)) / 2 ** zoom;

/**
 * The fan, derived rather than tabulated.
 *
 * A service's drawn position is one number, read two ways and crossfaded:
 *
 *     offset(px) = colourIndex * colour(z)  +  metricBand * metric(z)  +  metricBand * geo(z)
 *
 * The last term is not ours — it is the 4.6 m the geometry already carries, worth a growing
 * number of pixels as you zoom in. `metric(z)` supplies only the difference between that and what
 * the eye needs, so the total stays on target rather than two contributions being tuned against
 * each other and drifting apart in the middle of the range.
 *
 * The point of deriving both from the same band is that they cannot disagree. They used to: the
 * geometry was offset by the metric band and the fan by a colour/service split, two orderings
 * summed, and five lines sharing Queens Boulevard bunched and crossed and changed spacing as you
 * zoomed. Adding a colour term to a metric one is not a blend, it is a collision.
 */
export function fanAt(zoom: number): { colour: number; metric: number } {
  const geo = TRACK_M / metresPerPixel(zoom);
  const reveal = smoothstep((zoom - MERGE_BELOW) / (SEPARATE_ABOVE - MERGE_BELOW));
  return {
    // Zoomed out, the whole offset is the printed map's: one line per trunk colour.
    colour: (1 - reveal) * TARGET_PX,
    // Zoomed in, it is the track's own: evenly spaced bands, TARGET_PX apart, minus whatever the
    // real 4.6 m already provides. Past about zoom 18 the metres alone exceed the target and this
    // falls to nothing, so the lines stand exactly where the track does.
    metric: Math.max(reveal * TARGET_PX, geo) - geo,
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
      return [z, ["+", ["*", ["get", "cb"], f.colour * scale], ["*", ["get", "mb"], f.metric * scale]]];
    }),
  ];
}

/** One engine per network. Everything it lays out is cached for the life of it. */
export class LineEngine {
  private cache = new Map<string, LonLat[]>();
  private bands = new Map<string, { colour: number[]; metric: number[] }>();
  private strokeCache: Stroke[] | null = null;
  private platforms = new Map<string, LonLat | null>();
  private stands = new Map<string, string>();

  constructor(private readonly net: Network) {}

  /**
   * The signed band a train is riding, in the frame the drawn line is offset in.
   *
   * A line is offset to the right of the direction it happens to be *drawn*; a train is placed
   * relative to the direction it is *travelling*. Those are the same side only when the two
   * agree, so the sign is resolved here once and both read the identical number.
   */
  lateralBand(route: string, prevDir: string, nextDir: string, along?: number): { cb: number; mb: number } | undefined {
    const a = parentOf(prevDir), b = parentOf(nextDir);
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    const parts = this.net.bandParts?.[key]?.[this.standIn(route, key)];
    if (!parts) return undefined;
    const side = (this.net.segDir?.[key] ?? 1) * (a < b ? 1 : -1);

    /*
     * Where along the stretch, because the band is not the same all the way down it.
     *
     * A service changing band sweeps across the junction rather than stepping, and the line is
     * drawn that way — the offset eases from one band to the next over a hundred and thirty
     * metres. A train was placed at the stretch's *middle* band for the whole of its length, so
     * through the sweep it cut the corner while its own line went round: nineteen pixels off the
     * track it is running on, at the exact place the map is hardest to read.
     *
     * The line's own profile is read here instead. `along` is how far into the stretch the train
     * is, in the direction it is travelling.
     */
    if (along !== undefined) {
      const ramp = this.bandsAlong(route, key);
      if (ramp) {
        const n = ramp.metric.length;
        // The profile is stored in the stretch's own point order; a train travelling the other way
        // reads it backwards.
        const t = Math.max(0, Math.min(1, a < b ? along : 1 - along));
        const at = t * (n - 1);
        const i = Math.min(n - 2, Math.floor(at));
        const f = n > 1 ? at - i : 0;
        const cb = ramp.colour[i] + (ramp.colour[i + 1] - ramp.colour[i]) * f;
        const mb = ramp.metric[i] + (ramp.metric[i + 1] - ramp.metric[i]) * f;
        return { cb: cb * side, mb: mb * side };
      }
    }
    return { cb: parts[0] * side, mb: parts[1] * side };
  }

  /**
   * Which service's band to ride, when this one has none here.
   *
   * The feed runs services off their own schedule — a C extended past 168 St onto the A's track,
   * an R terminating at Forest Hills on the E and F's. The track is there and the train is really
   * on it; what is missing is a band, because the band ordering was built from the timetable and
   * the timetable does not know about this trip. Falling back to zero put those trains on the
   * centreline of the corridor, running between the lines rather than on one — about one moving
   * train in twenty.
   *
   * So it borrows: the service on this stretch from its own trunk line if there is one — a C
   * takes the A's band, which is the track it is actually sharing — and otherwise the nearest by
   * the MTA's own ordering, which groups services by trunk and puts locals beside their expresses.
   */
  private standIn(route: string, key: string): string {
    const memo = `${route}|${key}`;
    const hit = this.stands.get(memo);
    if (hit !== undefined) return hit;
    let pick = route;
    const here = this.net.segmentSlots?.[key];
    if (here && !here[route]) {
      const mine = trunkOf(route)?.id;
      const order = (r: string) => this.net.routes[r]?.sortOrder ?? 999;
      let best: string | undefined;
      let bestCost = Infinity;
      for (const other of Object.keys(here)) {
        const sameTrunk = mine !== undefined && trunkOf(other)?.id === mine;
        const cost = (sameTrunk ? 0 : 1000) + Math.abs(order(other) - order(route));
        if (cost < bestCost) { bestCost = cost; best = other; }
      }
      if (best) pick = best;
    }
    this.stands.set(memo, pick);
    return pick;
  }

  /**
   * One stretch of one service, laid into its band — the single source of truth for where that
   * service is drawn and where its trains ride. Lines and trains once computed this separately
   * and disagreed: a train sat 6 m off its own line normally and 9 m off once the view narrowed.
   *
   * Returned in the segment's canonical (u < v) order; callers reverse it if they need the other.
   */
  private laid(route: string, key: string): LonLat[] | undefined {
    const pts = this.net.segments[key];
    if (!pts) return undefined;
    let out = this.cache.get(`${route}|${key}`);
    if (!out) {
      const rides = this.standIn(route, key);
      const band = this.net.segmentSlots[key]?.[rides]?.[0] ?? 0;
      const [u, v] = this.net.laneEnds?.[key]?.[rides] ?? [band, band];
      // The band is measured in the corridor's own direction; this stretch's points may be stored
      // the other way round, in which case the whole offset flips with them.
      const m = TRACK_M * (this.net.segDir?.[key] ?? 1);
      out = offsetPolylineRamped(pts, band * m, u * m, v * m, RAMP_M);
      this.cache.set(`${route}|${key}`, out);
    }
    return out;
  }

  /**
   * The band each point of a stretch sits on, both readings, in the corridor's frame.
   *
   * The geometry eases from one band into the next across a station rather than stepping, and
   * this is that same easing read out as numbers. It exists because the screen offset has to
   * follow the same profile: `line-offset` is one constant per feature, so a service that changes
   * band has its geometry swept smoothly across the junction and its pixels jumped — up to 24 px
   * at zoom 15, which is two lines' width, and is what made strokes look cut off rather than
   * joined. Splitting a stretch into short pieces along this profile puts the two back in step.
   *
   * Deliberately the same arithmetic as `offsetPolylineRamped`, because agreeing with it is the
   * entire point; if the two ever drift the lines come apart again.
   */
  private bandsAlong(route: string, key: string): { colour: number[]; metric: number[] } | undefined {
    const pts = this.net.segments[key];
    if (!pts || pts.length < 2) return undefined;
    const cached = this.bands.get(`${route}|${key}`);
    if (cached) return cached;

    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + distM(pts[i - 1], pts[i]));
    const total = cum[cum.length - 1] || 1;
    const ramp = Math.min(RAMP_M, total / 2);
    const ease = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
    const profile = (mid: number, atStart: number, atEnd: number) =>
      cum.map((d) => {
        if (d < ramp) return atStart + (mid - atStart) * ease(d / ramp);
        if (d > total - ramp) return mid + (atEnd - mid) * ease((d - (total - ramp)) / ramp);
        return mid;
      });

    const rides = this.standIn(route, key);
    const metricMid = this.net.segmentSlots[key]?.[rides]?.[0] ?? 0;
    const [ms, me] = this.net.laneEnds?.[key]?.[rides] ?? [metricMid, metricMid];
    const colourMid = this.net.bandParts?.[key]?.[rides]?.[0] ?? 0;
    const [cs, ce] = this.net.colourEnds?.[key]?.[rides] ?? [colourMid, colourMid];
    const out = { metric: profile(metricMid, ms, me), colour: profile(colourMid, cs, ce) };
    this.bands.set(`${route}|${key}`, out);
    return out;
  }

  /**
   * One stretch as drawn, with the band each point sits on — everything a renderer needs to lay
   * a service down and keep its screen offset in step with its geometry.
   */
  lineSegmentBands(route: string, u: string, v: string): { pts: LonLat[]; colour: number[]; metric: number[] } | undefined {
    const key = u < v ? `${u}-${v}` : `${v}-${u}`;
    const laid = this.laid(route, key);
    const bands = this.bandsAlong(route, key);
    if (!laid || !bands) return undefined;
    if (u < v) return { pts: laid, colour: bands.colour, metric: bands.metric };
    return { pts: [...laid].reverse(), colour: [...bands.colour].reverse(), metric: [...bands.metric].reverse() };
  }

  /**
   * Every stroke the map draws, ready to offset.
   *
   * This lives here rather than in the renderer because the renderer is not the only thing that
   * needs to know: `npm run audit:layout` checks that the strokes meet where they should, and it
   * has to be checking the same strokes that get drawn. Two implementations of "how the network
   * is cut into features" is how the geometry and the screen offset came to disagree in the first
   * place.
   *
   * A run is cut wherever its band has moved more than `BAND_STEP` since the piece began, because
   * `line-offset` is one constant per feature. That is what makes a change of band read as a
   * splay rather than a break: the geometry already sweeps across the junction, and cutting here
   * lets the screen offset sweep with it. Drawn one feature per run, the curve swept and the
   * pixels jumped, and the strokes either side of a junction missed each other by up to 24 px.
   */
  strokes(): Stroke[] {
    if (this.strokeCache) return this.strokeCache;
    const out: Stroke[] = [];
    for (const [route, runs] of Object.entries(this.net.routeRuns ?? {})) {
      // The line takes the colour a line is drawn in, which on a black ground is not always the
      // colour the emblem is printed in.
      const colour = this.net.routes[route]?.lineColor ?? this.net.routes[route]?.color;
      if (!colour) continue;
      for (let r = 0; r < runs.length; r++) {
        const run = runs[r];
        const side = run.side ?? 1;
        const pts: LonLat[] = [], cb: number[] = [], mb: number[] = [];
        for (let i = 0; i + 1 < run.stops.length; i++) {
          const piece = this.lineSegmentBands(route, run.stops[i], run.stops[i + 1]);
          if (!piece) continue;
          for (let k = 0; k < piece.pts.length; k++) {
            const p = piece.pts[k], last = pts[pts.length - 1];
            // Two stretches meet within a third of a metre of one another, not exactly, so an
            // exact test leaves a sub-metre jog between two edges hundreds of metres long. Which
            // is a hairpin: the line turns almost fully around and back, and a round join draws
            // that as a blister on an otherwise smooth curve. There were 673 of them.
            if (last && (k > 0 ? last[0] === p[0] && last[1] === p[1] : distM(last, p) < JOIN_M)) continue;
            pts.push(p);
            cb.push(piece.colour[k] * side);
            mb.push(piece.metric[k] * side);
          }
        }
        if (pts.length < 2) continue;

        /*
         * Give the ramp enough points to be smooth.
         *
         * A stretch's vertices are spaced by whatever survived simplification — tens of metres —
         * and the ramp is at most 130 m, and shorter on a short stretch. So the band can move
         * three quarters of a track between two neighbouring points, and no amount of cutting
         * between existing points can draw that as anything but a step. Splitting the edge is
         * the only thing that can, and it costs a handful of points in the few places it happens.
         */
        for (let i = pts.length - 1; i > 0; i--) {
          const steps = Math.ceil(Math.max(Math.abs(cb[i] - cb[i - 1]), Math.abs(mb[i] - mb[i - 1])) / (BAND_STEP / 2));
          if (steps < 2) continue;
          const ins: LonLat[] = [], insC: number[] = [], insM: number[] = [];
          for (let k = 1; k < steps; k++) {
            const t = k / steps;
            ins.push([pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t]);
            insC.push(cb[i - 1] + (cb[i] - cb[i - 1]) * t);
            insM.push(mb[i - 1] + (mb[i] - mb[i - 1]) * t);
          }
          pts.splice(i, 0, ...ins);
          cb.splice(i, 0, ...insC);
          mb.splice(i, 0, ...insM);
        }

        // A piece is drawn at the mean of the bands it spans, so its error is half a step.
        const at = (arr: number[], from: number, to: number) => (arr[from] + arr[to]) / 2;
        const emit = (from: number, to: number) => out.push({
          route, colour, run: `${route}#${r}`,
          first: from === 0, last: to === pts.length - 1,
          slot: run.slot, shared: run.shared, z: run.z ?? 2,
          cb: at(cb, from, to), mb: at(mb, from, to),
          pts: pts.slice(from, to + 1),
        });
        let from = 0;
        for (let i = 1; i < pts.length; i++) {
          if (Math.abs(cb[i] - cb[from]) < BAND_STEP && Math.abs(mb[i] - mb[from]) < BAND_STEP) continue;
          // Pieces overlap by a point, so there is no gap between them to see.
          emit(from, i);
          from = i;
        }
        // Only if anything is left: a cut on the last point has already drawn it.
        if (from < pts.length - 1) emit(from, pts.length - 1);
      }
    }
    return (this.strokeCache = out);
  }

  /**
   * Where a train of this route stands when it is at this platform.
   *
   * Not the station's coordinate: that is the middle of the corridor, and a service is drawn in
   * its own band beside it. Taking the end of the route's own drawn stretch puts a standing train
   * exactly where its line is — measured, dwelling trains sat a median 2.3 m and up to 9.2 m off
   * the track they belong to, which is one to two bands and plainly visible close in.
   */
  platformPoint(route: string, stopId: string): LonLat | undefined {
    // Where a platform is does not change, and this is asked for every standing train on every
    // frame: at three hundred of them it was a fifth of a second per second of animation, spent
    // walking a route's whole segment list to arrive at the same answer as last time.
    const memo = `${route}|${stopId}`;
    const hit = this.platforms.get(memo);
    if (hit !== undefined) return hit ?? undefined;
    const station = parentOf(stopId);
    for (const key of this.net.routeSegments[route] ?? []) {
      const [a, b] = key.split("-");
      if (a !== station && b !== station) continue;
      const laid = this.laid(route, key);
      if (!laid?.length) continue;
      const at = a === station ? laid[0] : laid[laid.length - 1];
      this.platforms.set(memo, at);
      return at;
    }
    this.platforms.set(memo, null);
    return undefined;
  }

  /** Coordinates for one stretch as drawn. */
  lineSegment(route: string, u: string, v: string): LonLat[] | undefined {
    const key = u < v ? `${u}-${v}` : `${v}-${u}`;
    const laid = this.laid(route, key);
    if (!laid) return undefined;
    return u < v ? laid : [...laid].reverse();
  }
}
