import { paint } from "./mapTheme";
import type { Map as MapLibreMap } from "maplibre-gl";
import type { NetworkIndex } from "./network";

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

/** Register one chevron per route; safe to call more than once. */
export function addRouteIcons(map: MapLibreMap, index: NetworkIndex) {
  const ratio = Math.min(3, Math.max(2, Math.round((globalThis.devicePixelRatio || 1) * SCALE)));
  for (const route of Object.keys(index.net.routes)) {
    const id = chevronId(route);
    if (map.hasImage(id)) continue;
    const img = chevron(index.routeColor(route), ratio);
    if (img) map.addImage(id, img, { pixelRatio: ratio });
  }
}
