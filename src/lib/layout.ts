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
 *  - **Intertwined.** Where bands cross, one passes over: bands further right always draw above
 *    bands further left, so a pair never weaves one way here and the other way there.
 *  - **Proportioned.** Two lines sit the same distance apart on screen at every zoom, because the
 *    fan is what the eye needs *minus* what the true track spacing already provides.
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
import { offsetPolylineRamped } from "./geo";

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

/** Metres per pixel at New York's latitude. */
export const metresPerPixel = (zoom: number) => (156_543.03 * Math.cos((40.73 * Math.PI) / 180)) / 2 ** zoom;

/**
 * The fan, derived rather than tabulated.
 *
 * The geometry already carries the true 4.6 m between track centres, worth a growing number of
 * pixels as you zoom in. The fan adds only the difference between that and what the eye needs, so
 * the total stays on target instead of two contributions being tuned against each other by hand
 * and drifting apart in the middle of the range.
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

/** One engine per network. Everything it lays out is cached for the life of it. */
export class LineEngine {
  private cache = new Map<string, LonLat[]>();

  constructor(private readonly net: Network) {}

  /**
   * The signed band a train is riding, in the frame the drawn line is offset in.
   *
   * A line is offset to the right of the direction it happens to be *drawn*; a train is placed
   * relative to the direction it is *travelling*. Those are the same side only when the two
   * agree, so the sign is resolved here once and both read the identical number.
   */
  lateralBand(route: string, prevDir: string, nextDir: string): { cb: number; sb: number } | undefined {
    const a = parentOf(prevDir), b = parentOf(nextDir);
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    const parts = this.net.bandParts?.[key]?.[route];
    if (!parts) return undefined;
    const side = (this.net.segDir?.[key] ?? 1) * (a < b ? 1 : -1);
    return { cb: parts[0] * side, sb: parts[1] * side };
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
      const band = this.net.segmentSlots[key]?.[route]?.[0] ?? 0;
      const [u, v] = this.net.laneEnds?.[key]?.[route] ?? [band, band];
      // The band is measured in the corridor's own direction; this stretch's points may be stored
      // the other way round, in which case the whole offset flips with them.
      const m = TRACK_M * (this.net.segDir?.[key] ?? 1);
      out = offsetPolylineRamped(pts, band * m, u * m, v * m, RAMP_M);
      this.cache.set(`${route}|${key}`, out);
    }
    return out;
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
}
