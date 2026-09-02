import { paint } from "./mapTheme";
import type { Map as MapLibreMap } from "maplibre-gl";
import type { NetworkIndex } from "./network";
import { isExpress, serviceLabel } from "./service";
import { BOX, CASING, FONT_STACK, FONT_WEIGHT, baseline, bulletBox, bulletOrigin, bulletPath, characterSize } from "./roundel";

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
 * The route bullet, rasterised into the map's image atlas.
 *
 * The same path string the panel renders as SVG, filled and stroked on a canvas with the same
 * font at the same size and the same baseline. The marker for a 6 train on the map is not a
 * facsimile of the bullet in the panel, it is the bullet.
 *
 * A circle layer carries its states in paint properties and an image cannot, so the three that
 * change the drawing are baked as variants and chosen per feature. Fading — a train the feed has
 * gone quiet about — stays a paint property, where it applies to all of them.
 */
export type BulletState = "plain" | "hold" | "parked";
export const bulletId = (route: string, state: BulletState) => `tt-bullet-${state}-${route}`;

/*
 * A bullet is never drawn larger than about twenty-four points, so a hundred-pixel texture for a
 * hundred-unit box is already twice the resolution it can use. It was being rasterised at three
 * times that — eighty-seven images at three hundred pixels square, eight million pixels of canvas
 * work at start-up and a texture atlas to match, for markers a quarter of an inch across.
 */
const BULLET_RATIO = 1;

function bullet(route: string, index: NetworkIndex, state: BulletState, ratio: number): ImageData | null {
  const express = isExpress(route);
  // The image is as big as the drawing: an express diamond reaches past the circle's box, and the
  // map scales by the image's own size, so the character comes out the same on both.
  const box = bulletBox(express), o = bulletOrigin(express);
  const c = document.createElement("canvas");
  c.width = c.height = Math.round(box * ratio);
  const g = c.getContext("2d");
  if (!g) return null;
  g.scale(ratio, ratio);
  g.translate(o, o);

  const colour = index.routeColor(route);
  const label = serviceLabel(route);
  // A held train is ringed amber, and one not yet in service is drawn hollow: it is here, but it
  // is not running, and a solid bullet claims otherwise.
  const ring = state === "hold" ? CASING * 2.4 : CASING;
  const path = new Path2D(bulletPath(express, ring / 2));
  g.fillStyle = state === "parked" ? paint("--map-station-fill") : colour;
  g.fill(path);
  g.lineWidth = ring;
  g.lineJoin = "round";
  g.strokeStyle = state === "hold" ? paint("--map-hold") : state === "parked" ? colour : paint("--map-casing");
  g.stroke(path);

  g.fillStyle = state === "parked" ? colour : index.net.routes[route]?.textColor ?? paint("--route-unknown-text");
  g.font = `${FONT_WEIGHT} ${characterSize(label)}px ${FONT_STACK}`;
  g.textAlign = "center";
  g.textBaseline = "alphabetic";
  g.fillText(label, BOX / 2, baseline(label));
  return g.getImageData(0, 0, c.width, c.height);
}

/** Register a chevron and a bullet per service, in each state; safe to call more than once. */
export function addRouteIcons(map: MapLibreMap, index: NetworkIndex) {
  const ratio = Math.min(3, Math.max(2, Math.round((globalThis.devicePixelRatio || 1) * SCALE)));
  for (const route of Object.keys(index.net.routes)) {
    const id = chevronId(route);
    if (!map.hasImage(id)) {
      // A chevron sits on the map, on black, so it takes the colour the line does.
      const img = chevron(index.routeLineColor(route), ratio);
      if (img) map.addImage(id, img, { pixelRatio: ratio });
    }
    for (const state of ["plain", "hold", "parked"] as BulletState[]) {
      const bid = bulletId(route, state);
      if (map.hasImage(bid)) continue;
      const img = bullet(route, index, state, BULLET_RATIO);
      if (img) map.addImage(bid, img, { pixelRatio: BULLET_RATIO });
    }
  }
}
