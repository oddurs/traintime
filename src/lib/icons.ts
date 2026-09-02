import { paint } from "./mapTheme";
import type { Map as MapLibreMap } from "maplibre-gl";
import type { NetworkIndex } from "./network";
import { isExpress } from "./service";

/**
 * A chevron per route, drawn once into the map's image atlas. The chevron sits in the upper
 * part of a taller transparent canvas, so rotating the icon by the train's bearing places it
 * ahead of the marker without any offset maths.
 */
const W = 26;
const H = 74;
const SCALE = 2;

function chevron(color: string, ratio: number): ImageData | null {
  const c = document.createElement("canvas");
  c.width = W * ratio;
  c.height = H * ratio;
  const g = c.getContext("2d");
  if (!g) return null;
  g.scale(ratio, ratio);
  g.translate(W / 2, 0);
  g.beginPath();
  g.moveTo(0, 3);
  g.lineTo(8.5, 15);
  g.lineTo(0, 11);
  g.lineTo(-8.5, 15);
  g.closePath();
  g.fillStyle = color;
  g.strokeStyle = paint("--map-chevron-edge");
  g.lineWidth = 1.4;
  g.lineJoin = "round";
  g.stroke();
  g.fill();
  return g.getImageData(0, 0, c.width, c.height);
}

export const chevronId = (route: string) => `tt-chevron-${route}`;

/**
 * The express diamond, drawn once per service and per state.
 *
 * A circle layer cannot be a diamond, and without one an express train and a local one were the
 * same mark on the map: a 6X drew as a "6" in a circle, exactly like a 6, and nothing said which
 * you were looking at. The panel has drawn them apart since the beginning — the manual's own
 * distinction — so the map does too.
 *
 * A circle layer carries its states in paint properties; an image cannot, so the three that
 * change the drawing rather than its opacity are baked as variants. Fading — a train the feed has
 * gone quiet about — stays a paint property and applies to all of them.
 */
export type Diamond = "plain" | "hold" | "parked";
export const diamondId = (route: string, state: Diamond) => `tt-diamond-${state}-${route}`;

/** The logical size the diamond images are drawn at; the layer scales from here. */
export const DIAMOND_PX = 26;

function diamond(color: string, state: Diamond, ratio: number): ImageData | null {
  const c = document.createElement("canvas");
  c.width = c.height = DIAMOND_PX * ratio;
  const g = c.getContext("2d");
  if (!g) return null;
  g.scale(ratio, ratio);
  const m = DIAMOND_PX / 2;
  const ring = state === "hold" ? 3 : 2;
  // Inset by the ring so the stroke lands inside the image rather than being clipped by it.
  const r = m - ring / 2 - 0.5;
  g.beginPath();
  g.moveTo(m, m - r);
  g.lineTo(m + r, m);
  g.lineTo(m, m + r);
  g.lineTo(m - r, m);
  g.closePath();
  g.fillStyle = state === "parked" ? paint("--map-station-fill") : color;
  g.fill();
  g.lineWidth = ring;
  g.lineJoin = "round";
  g.strokeStyle = state === "hold" ? paint("--map-hold") : state === "parked" ? color : paint("--label");
  g.stroke();
  return g.getImageData(0, 0, c.width, c.height);
}

/** Register a chevron per route, and a diamond per express service; safe to call more than once. */
export function addRouteIcons(map: MapLibreMap, index: NetworkIndex) {
  const ratio = Math.min(3, Math.max(2, Math.round((globalThis.devicePixelRatio || 1) * SCALE)));
  for (const route of Object.keys(index.net.routes)) {
    const id = chevronId(route);
    if (!map.hasImage(id)) {
      // A chevron sits on the map, on black, so it takes the colour the line does.
      const img = chevron(index.routeLineColor(route), ratio);
      if (img) map.addImage(id, img, { pixelRatio: ratio });
    }
    if (!isExpress(route)) continue;
    for (const state of ["plain", "hold", "parked"] as Diamond[]) {
      const did = diamondId(route, state);
      if (map.hasImage(did)) continue;
      const img = diamond(index.routeColor(route), state, ratio);
      if (img) map.addImage(did, img, { pixelRatio: ratio });
    }
  }
}
