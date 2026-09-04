import { BOX, CASING, FONT_STACK, FONT_WEIGHT, baseline, bulletPath, characterSize } from "./roundel";

/**
 * bound — the mark.
 *
 * The MTA's mark in the wild is not its wordmark, it is the bullet: a filled circle with one bold
 * Helvetica character in it, on every sign, every map and every train in the city. So the brand is
 * a bullet, drawn by the same `bulletPath` and set at the same size and baseline as the 1, the A
 * and the G — the mark is a member of the system rather than a logo placed beside it.
 *
 * The play is that it is the one bullet that is not a line. Every service is a colour with white
 * or black on it; this one inverts the system, ink for ground and ground for ink, so it reads
 * instantly as a subway bullet while claiming no route. There is no B here that could be mistaken
 * for the 6 Avenue B, because no line is drawn this way.
 *
 * The name is the subway's own word for direction — Manhattan-bound, Brooklyn-bound — which is
 * what the whole application is about: not where a train is, but which way it is going and when it
 * reaches you.
 */
export const BRAND_NAME = "bound";
export const BRAND_CHARACTER = "B";
export const BRAND_TAGLINE = "New York City subway, live";

/**
 * The mark as SVG.
 *
 * One builder for all of it: the React component renders this inline, and scripts/build-icons.ts
 * rasterises the same string into the app icons. An icon that drifts from the mark in the interface
 * is the usual way a brand comes apart, and there is only one drawing here to drift from.
 *
 * Colours are passed in rather than read from tokens, because this is also called from a build
 * script with no stylesheet and no browser to resolve a custom property against.
 */
export function brandMarkSvg(ground: string, ink: string, size = BOX): string {
  const label = BRAND_CHARACTER;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${BOX} ${BOX}" width="${size}" height="${size}" role="img" aria-label="${BRAND_NAME}">`,
    `<path d="${bulletPath(false, CASING / 2)}" fill="${ground}"/>`,
    `<text x="${BOX / 2}" y="${baseline(label)}" text-anchor="middle"`,
    ` font-family='${FONT_STACK}' font-weight="${FONT_WEIGHT}" font-size="${characterSize(label)}" fill="${ink}">${label}</text>`,
    `</svg>`,
  ].join("");
}

/**
 * The app icon: the mark on the ground the map itself uses.
 *
 * The bullet is white, so on a transparent or white tile it has no edge and stops being a bullet —
 * it is just a letter floating in a square, which is what the first attempt looked like. Signage in
 * the system is white on black, and so is the map, so the icon is a black tile with the white
 * bullet sitting on it. The disc is inset rather than bled to the edges, because a circle cropped
 * by a platform's mask is a shape nobody chose.
 */
export function brandIconSvg(tile: string, ground: string, ink: string, px: number): string {
  const label = BRAND_CHARACTER;
  // The middle 80% is the safe zone every platform's mask keeps, so the bullet lives inside it.
  const inset = BOX * 0.12;
  const scale = (BOX - inset * 2) / BOX;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${BOX} ${BOX}" width="${px}" height="${px}">`,
    `<rect width="${BOX}" height="${BOX}" fill="${tile}"/>`,
    `<g transform="translate(${inset} ${inset}) scale(${scale})">`,
    `<path d="${bulletPath(false, 0)}" fill="${ground}"/>`,
    `<text x="${BOX / 2}" y="${baseline(label)}" text-anchor="middle"`,
    ` font-family='${FONT_STACK}' font-weight="${FONT_WEIGHT}" font-size="${characterSize(label)}" fill="${ink}">${label}</text>`,
    `</g></svg>`,
  ].join("");
}
