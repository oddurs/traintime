/**
 * Where the map opens, and how the loading poster is placed over it.
 *
 * The poster is the network drawn ahead of time, at this view, as one small SVG
 * (scripts/build-poster.ts). It is in the page's first paint, seconds before the map engine,
 * its geometry and the basemap have arrived, and the real map fades in over it. That only reads as
 * the map arriving, rather than one picture replacing another, if the two are drawn in the same
 * place — so both read the view from here.
 */
export const HOME = { lon: -73.955, lat: 40.735, zoom: 11.4 } as const;

/** MapLibre's world: 512 px square at zoom 0. */
const TILE = 512;

/** Web Mercator, in pixels at `zoom`. */
export function project(lon: number, lat: number, zoom: number): [number, number] {
  const world = TILE * 2 ** zoom;
  const s = Math.sin((lat * Math.PI) / 180);
  return [((lon + 180) / 360) * world, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * world];
}

/**
 * The CSS transform that puts the poster under a map opened somewhere other than home, or null
 * where it cannot stand in for that map.
 *
 * The poster is drawn at the home zoom with lines a pixel and a half wide. Scaled up much past one
 * zoom level those become ribbons, and scaled down they vanish, so beyond that range the page shows
 * the ground alone rather than a picture that is plainly not the map.
 */
export function posterTransform(view: { lon: number; lat: number; zoom: number } | undefined): string | null {
  if (!view) return "";
  const dz = view.zoom - HOME.zoom;
  if (Math.abs(dz) > 1) return null;
  const [hx, hy] = project(HOME.lon, HOME.lat, view.zoom);
  const [vx, vy] = project(view.lon, view.lat, view.zoom);
  const k = 2 ** dz;
  return `translate(${(hx - vx).toFixed(1)}px, ${(hy - vy).toFixed(1)}px) scale(${k.toFixed(4)})`;
}
