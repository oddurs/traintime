/**
 * The route bullet: one drawing, used everywhere a service is named.
 *
 * A bullet in the panel and a train marker on the map were two different drawings of one emblem —
 * the panel's a CSS circle with Helvetica in it, the map's a circle layer with a white ring and a
 * label in the tile style's own font. Same 6 train, two marks. So the geometry lives here, as a
 * path and a handful of numbers, and both are drawn from it: the panel renders the path as SVG,
 * the map rasterises the same path into its image atlas. They cannot disagree, because there is
 * only one of them.
 *
 * The proportions are the MTA's. A circle bullet for a local service; a diamond — a square on its
 * point, corners just softened — for an express, spanning the same box so the two sit at the same
 * size beside each other. The character is set bold in Helvetica, and its *capital* is centred on
 * the shape rather than its em box, which is what stops a numeral riding high.
 */

/** Everything is described in a 100-unit box and scaled at the point of use. */
export const BOX = 100;

/**
 * The dark casing, in box units.
 *
 * The map draws every line with one and a bullet needs the same: sitting on top of its own route,
 * a red 1 on the red 7 Avenue line has nothing to separate it. On the panel's dark ground it is
 * invisible, which is how the same drawing serves both.
 */
export const CASING = 3;

/** Font size as a fraction of the box, by how many characters have to fit. */
const SIZE_BY_LENGTH = [0.7, 0.7, 0.5, 0.38];
/**
 * How much wider an express diamond is drawn than the circle it stands beside.
 *
 * A diamond has half the width of a circle at the height a capital crosses it, so drawn to the
 * same box its character has to shrink — and a diamond service then reads as a lesser version of
 * the round one next to it. The MTA draws the diamond larger instead, and so does this: the shape
 * grows and the character does not, which is what makes the two read as equals.
 */
export const DIAMOND_SCALE = 1.14;

/** The outer box a bullet occupies, which for an express is wider than the circle's. */
export const bulletBox = (express: boolean) => (express ? BOX * DIAMOND_SCALE : BOX);
/** Where that box starts, relative to the circle's own coordinates. */
export const bulletOrigin = (express: boolean) => (bulletBox(express) - BOX) / 2;

/** Helvetica's capitals, as a fraction of its point size. */
export const CAP_HEIGHT = 0.717;

export const FONT_WEIGHT = 700;
export const FONT_STACK = '"Helvetica Neue", Helvetica, Arial, sans-serif';

/** How big the character is set, in box units — the same whichever shape holds it. */
export const characterSize = (label: string) =>
  BOX * (SIZE_BY_LENGTH[Math.min(label.length, SIZE_BY_LENGTH.length - 1)] ?? SIZE_BY_LENGTH[3]);

/**
 * Where the baseline goes so that the capital is centred on the shape.
 *
 * A line box is centred on the em square and a capital sits in its upper part, so centring the box
 * leaves the character riding high — the first thing that reads as wrong about a mark whose shape
 * everyone already knows. Half a cap height below the middle is where it belongs, and the same
 * number works for canvas and for SVG because both measure from the alphabetic baseline.
 */
export const baseline = (label: string) => BOX / 2 + (characterSize(label) * CAP_HEIGHT) / 2;

/** The corner radius of an express diamond, in box units — softened, not rounded. */
const DIAMOND_RADIUS = 6;

/**
 * The outline, as SVG path data.
 *
 * One string, drawn by `<path d>` in the panel and by `new Path2D(...)` on the map's canvas: the
 * two are the same curve by construction rather than by two people agreeing on a shape.
 *
 * `inset` pulls the outline in by half the casing so the stroke lands inside the box and the
 * coloured area still reaches the full diameter.
 */
export function bulletPath(express: boolean, inset = CASING / 2): string {
  const c = BOX / 2;
  const r = (bulletBox(express) - BOX) / 2 + c - inset;
  if (!express) {
    // A circle, as two half-arcs: `A` is the only arc SVG and Path2D both understand.
    return `M ${c - r} ${c} A ${r} ${r} 0 1 0 ${c + r} ${c} A ${r} ${r} 0 1 0 ${c - r} ${c} Z`;
  }
  // A square on its point, spanning the same box as the circle it replaces, with its corners
  // taken off by a quadratic through each vertex.
  const v: [number, number][] = [[c, c - r], [c + r, c], [c, c + r], [c - r, c]];
  const k = DIAMOND_RADIUS;
  const towards = (from: [number, number], to: [number, number]): [number, number] => {
    const dx = to[0] - from[0], dy = to[1] - from[1];
    const len = Math.hypot(dx, dy) || 1;
    return [from[0] + (dx / len) * k, from[1] + (dy / len) * k];
  };
  let d = "";
  for (let i = 0; i < 4; i++) {
    const prev = v[(i + 3) % 4], here = v[i], next = v[(i + 1) % 4];
    const a = towards(here, prev), b = towards(here, next);
    d += `${i === 0 ? `M ${a[0].toFixed(2)} ${a[1].toFixed(2)}` : `L ${a[0].toFixed(2)} ${a[1].toFixed(2)}`}`;
    d += ` Q ${here[0].toFixed(2)} ${here[1].toFixed(2)} ${b[0].toFixed(2)} ${b[1].toFixed(2)} `;
  }
  return `${d}Z`;
}
