import { CAP_HEIGHT, FONT_STACK, FONT_WEIGHT } from "./roundel";

/**
 * bound — the mark.
 *
 * Taken from the MTA's own corporate logo rather than from its service bullets. That mark is not
 * letters sitting inside a disc: the type is set so large that it bursts out of the circle, and
 * where it does, the disc is simply not there — the M and the A breach the top and the bottom and
 * leave the ring open. The letters are the shape; the circle is what is left of it.
 *
 * So this is a disc with a B set past its diameter. The bar of the B presses through the top and
 * the bottom, the counters are knocked out rather than painted, and what survives on the left is a
 * crescent of the circle standing on its own — the same fragment the MTA's M leaves behind.
 *
 * It is deliberately not a route bullet. Every service in this app is a character sitting neatly
 * inside its disc, and this is the one mark in the system that breaks out of one, which is what
 * makes it a logo and not a line. It cannot be mistaken for the 6 Avenue B, because no service is
 * ever drawn this way.
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
 * The character is a hole rather than a shape. Painting it in the background's colour would only
 * work on that background, and this sits on a translucent panel over a moving map; knocking it out
 * with a mask means the mark carries no assumption about what is behind it.
 */

/*
 * A mask is a stencil rather than a picture: its luminance decides what survives, so these two are
 * not colours and have no business in the palette. Named so, because they are the one place in the
 * app where a bare #000 and #fff are the right thing to write — see scripts/audit-design.ts, which
 * allows them here by that name and nowhere else.
 */
const STENCIL_HIDE = "#000";
const STENCIL_SHOW = "#fff";

/** How tall the character stands against the disc's diameter. Past 1 it breaks out of the circle. */
const BREACH = 0.84;
const DISC = 100;

function markBody(id: string, ground: string): string {
  const size = (DISC * BREACH) / CAP_HEIGHT;
  return [
    `<mask id="${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="${DISC}" height="${DISC}">`,
    `<rect width="${DISC}" height="${DISC}" fill="${STENCIL_HIDE}"/>`,
    `<circle cx="${DISC / 2}" cy="${DISC / 2}" r="${DISC / 2}" fill="${STENCIL_SHOW}"/>`,
    `<text x="${DISC / 2}" y="${DISC / 2 + (DISC * BREACH) / 2}" text-anchor="middle"`,
    ` font-family='${FONT_STACK}' font-weight="${FONT_WEIGHT}" font-size="${size}" fill="${STENCIL_HIDE}">${BRAND_CHARACTER}</text>`,
    `</mask>`,
    `<rect width="${DISC}" height="${DISC}" fill="${ground}" mask="url(#${id})"/>`,
  ].join("");
}

/**
 * The mark on its own, transparent behind. `id` keeps two marks on one page from sharing a mask,
 * which is the sort of thing that works until the day something renders twice.
 */
export function brandMarkSvg(ground: string, id = "bound-mark", size = DISC): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${DISC} ${DISC}" width="${size}" height="${size}" role="img" aria-label="${BRAND_NAME}">${markBody(id, ground)}</svg>`;
}

/**
 * The app icon: the mark on the ground the map itself uses.
 *
 * The disc is inset into the middle of the tile rather than bled to its edges, because the shape
 * is a circle with pieces missing and a platform's mask would take a second bite out of it.
 */
export function brandIconSvg(tile: string, ground: string, px: number): string {
  const inset = DISC * 0.14;
  const scale = (DISC - inset * 2) / DISC;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${DISC} ${DISC}" width="${px}" height="${px}">`,
    `<rect width="${DISC}" height="${DISC}" fill="${tile}"/>`,
    `<g transform="translate(${inset} ${inset}) scale(${scale})">${markBody("bound-icon", ground)}</g>`,
    `</svg>`,
  ].join("");
}
