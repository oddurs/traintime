/**
 * The map's palette, read from the same token layer as everything else.
 *
 * MapLibre paints into a canvas and cannot resolve `var(--x)`, so map colours were written out as
 * literals in the layer definitions — which put a second, invisible palette in the codebase that
 * the design audit could not see. These are read from the stylesheet at start-up instead, so
 * there is still exactly one place a colour is decided.
 *
 * The fallbacks are for a server render, where there is no document to read from; they are only
 * ever used to produce markup that the client immediately re-themes.
 */
const FALLBACK: Record<string, string> = {
  "--map-casing": "#000000",
  "--map-station-fill": "#0b0b0d",
  "--map-station-edge": "#c9c9d2",
  "--map-label": "#cfcfcf",
  "--map-halo": "#000000",
  "--map-uncertain": "#9fd0ff",
  "--map-hold": "#ffb454",
  "--map-focus": "rgba(255,255,255,0.08)",
  "--map-chevron-edge": "rgba(0,0,0,0.55)",
  "--route-unknown": "#808183",
  "--route-unknown-text": "#ffffff",
  "--label": "#f5f5f7",
};

let cache: Record<string, string> | null = null;

/** Every map colour, resolved once. */
export function mapTheme(): Record<string, string> {
  if (cache) return cache;
  if (typeof document === "undefined") return (cache = { ...FALLBACK });
  const css = getComputedStyle(document.documentElement);
  const out: Record<string, string> = {};
  for (const name of Object.keys(FALLBACK)) {
    const v = css.getPropertyValue(name).trim();
    out[name] = v || FALLBACK[name];
  }
  return (cache = out);
}

/** One colour by token name. */
export const paint = (name: keyof typeof FALLBACK | string): string => mapTheme()[name] ?? FALLBACK[name] ?? "#000";
