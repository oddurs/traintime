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
  "--label": "#f4f5f9",
  "--map-you": "#336dde",
  "--map-casing": "#000000",
  "--map-station-fill": "#0a0b0e",
  "--map-station-edge": "#c8cacd",
  "--map-label": "#c8cacd",
  "--map-halo": "#000000",
  "--map-uncertain": "#b2d9ff",
  "--map-hold": "#e5b800",
  "--map-focus": "rgba(255, 255, 255, 0.08)",
  "--map-chevron-edge": "rgba(0, 0, 0, 0.5)",
  "--trunk-7av": "#f53d35",
  "--trunk-lexington": "#008c3b",
  "--trunk-flushing": "#b630aa",
  "--trunk-8av": "#336dde",
  "--trunk-6av": "#e95500",
  "--trunk-broadway": "#ffce18",
  "--trunk-crosstown": "#52a325",
  "--trunk-nassau": "#9b6834",
  "--trunk-canarsie": "#848689",
  "--trunk-shuttle": "#6d6f72",
  "--trunk-sir": "#3091e1",
  "--ink-light": "#ffffff",
  "--ink-dark": "#000000",
  "--route-unknown": "#6d6f72",
  "--route-unknown-text": "#ffffff",
} as const;

export type PaletteToken = keyof typeof PALETTE;

/**
 * What the browser paints around the app before it has rendered anything: the address bar on a
 * phone, the splash screen of an installed copy. It is the map's own ground, so the transition
 * from chrome to canvas is invisible.
 */
export const CHROME_COLOR = PALETTE["--map-station-fill"];
