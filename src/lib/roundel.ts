/**
 * The roundel: one specification, for every place a service is named.
 *
 * A route bullet in the panel and a train marker on the map are the same emblem at two sizes, and
 * they were two drawings — the panel's set in Helvetica Medium at 58% of the diameter, the map's
 * in whatever the tile style's font stack offered at a size unrelated to the marker under it. So
 * the same 6 train read as two different marks depending on where you looked at it.
 *
 * The proportions are the MTA's own: the character is set in bold, optically centred, with a cap
 * height of about half the diameter. Helvetica's capitals are 0.717 of its point size, so a cap of
 * 0.50D wants a font size of about 0.70D. Two characters — GS, FS, SI — are set smaller to stay
 * inside the shape, and so is anything inside an express diamond, whose widest point across the
 * character's line is only 0.71 of the width of the circle it replaces.
 *
 * The numbers live here and the stylesheet declares them as tokens; scripts/audit-design.ts checks
 * the two agree, so neither can drift.
 */
export const ROUNDEL = {
  /** Font size as a fraction of the diameter, for one character in a circle. */
  circle: 0.7,
  /** Two characters in a circle. */
  circleWide: 0.5,
  /** One character in an express diamond. */
  diamond: 0.58,
  /** Two characters in an express diamond. */
  diamondWide: 0.44,
  /** Helvetica's cap height, as a fraction of its point size — what "half the diameter" means. */
  capHeight: 0.717,
  weight: 700,
} as const;

/** The font size a character should be set at inside a bullet of this diameter. */
export function characterPx(diameter: number, label: string, express: boolean): number {
  const ratio = express
    ? (label.length > 1 ? ROUNDEL.diamondWide : ROUNDEL.diamond)
    : (label.length > 1 ? ROUNDEL.circleWide : ROUNDEL.circle);
  return diameter * ratio;
}
