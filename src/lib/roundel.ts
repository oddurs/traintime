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
 * inside the shape.
 *
 * An express diamond carries exactly the same character. It looked as though it should need a
 * smaller one, and it was drawn that way, which made a diamond service read as a lesser version
 * of the circle beside it. It does not: the diamond is a square on its point inset 8% of the box,
 * so it spans 1.19 times the width of the circle it replaces, and at the height a capital crosses
 * it there is still 0.69D of room for a glyph 0.39D wide.
 *
 * The numbers live here and the stylesheet declares them as tokens; scripts/audit-design.ts checks
 * the two agree, so neither can drift.
 */
export const ROUNDEL = {
  /** Font size as a fraction of the diameter, for one character. */
  one: 0.7,
  /** Two characters — GS, FS, SI — set smaller to stay inside the shape. */
  two: 0.5,
  /** Helvetica's cap height, as a fraction of its point size — what "half the diameter" means. */
  capHeight: 0.717,
  weight: 700,
} as const;

/** The font size a character should be set at inside a bullet of this diameter. */
export function characterPx(diameter: number, label: string): number {
  return diameter * (label.length > 1 ? ROUNDEL.two : ROUNDEL.one);
}
