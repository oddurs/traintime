/**
 * The palette, in TypeScript.
 *
 * Almost everything reads its colours out of the stylesheet at run time, which keeps one source
 * of truth. Three things cannot: MapLibre paints into a canvas, the web manifest is static JSON
 * written at build time, and the theme colour goes into a <meta> before any document exists to
 * read from. Those need literals.
 *
 * So the literals live here, in one place, and scripts/audit-design.ts compares every one of them
 * against the token of the same name in globals.css and fails the build if they have drifted
 * apart. It is still one source of truth; this is a copy that cannot go stale quietly.
 */
export const PALETTE = {
  "--ground": "#000000",
  "--label": "#f5f5f7",
  "--map-you": "#0a84ff",
  "--map-casing": "#000000",
  "--map-station-fill": "#0b0b0d",
  "--map-station-edge": "#c9c9d2",
  "--map-label": "#c9c9d2",
  "--map-halo": "#000000",
  "--map-uncertain": "#9fd0ff",
  "--map-hold": "#ffb454",
  "--map-focus": "rgba(255, 255, 255, 0.08)",
  "--map-chevron-edge": "rgba(0, 0, 0, 0.5)",
  "--trunk-7av": "#ee352e",
  "--trunk-lexington": "#00933c",
  "--trunk-flushing": "#b933ad",
  "--trunk-8av": "#0039a6",
  "--trunk-6av": "#ff6319",
  "--trunk-broadway": "#fccc0a",
  "--trunk-crosstown": "#6cbe45",
  "--trunk-nassau": "#996633",
  "--trunk-canarsie": "#a7a9ac",
  "--trunk-shuttle": "#808183",
  "--trunk-sir": "#0078c6",
  "--line-8av": "#0053f3",
  "--ink-light": "#ffffff",
  "--ink-dark": "#000000",
  "--route-unknown": "#808183",
  "--route-unknown-text": "#ffffff",
} as const;

export type PaletteToken = keyof typeof PALETTE;

/**
 * What the browser paints around the app before it has rendered anything: the address bar on a
 * phone, the splash screen of an installed copy. It is the map's own ground, so the transition
 * from chrome to canvas is invisible.
 */
export const CHROME_COLOR = PALETTE["--map-station-fill"];
