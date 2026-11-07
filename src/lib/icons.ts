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

  g.fillStyle = state === "parked" ? colour : index.routeInk(route);
  g.font = `${FONT_WEIGHT} ${characterSize(label)}px ${FONT_STACK}`;
  g.textAlign = "center";
  g.textBaseline = "alphabetic";
  g.fillText(label, BOX / 2, baseline(label));
  return g.getImageData(0, 0, c.width, c.height);
}

/**
 * Every mark a train can be drawn as, in one texture.
 *
 * MapLibre keeps its own atlas for symbol layers, but a symbol layer cannot animate: moving one
 * means handing the source new geometry, which re-tiles and rebuilds the symbol buckets for every
 * feature, on a worker, across a thread boundary. That is why the trains were repositioned four
 * times a second instead of sixty. The custom layer in trainLayer.ts draws them itself, and it
 * needs its own atlas — one texture, so the whole system is one draw call.
 *
 * The marks are the same rasterisers the symbol layers used, so a train is the same drawing it
 * has always been; only who uploads it has changed.
 */
export interface AtlasRect {
  /** Where the mark sits in the texture, normalised. */
  u0: number; v0: number; u1: number; v1: number;
  /**
   * How big it is in layout units — its pixels divided by the ratio it was rasterised at, which is
   * what MapLibre's `icon-size` multiplies and therefore what the on-screen size is derived from.
   */
  w: number; h: number;
}

export interface TrainAtlas {
  image: ImageData;
  width: number;
  height: number;
  rect: (id: string) => AtlasRect | undefined;
}

const ATLAS_WIDTH = 2048;
const PAD = 1;

/**
 * Pack every bullet and chevron into one texture.
 *
 * Shelf packing, tallest first: the marks are all much the same size, so anything cleverer would
 * buy nothing. Returns null where there is no canvas to draw on, and the caller keeps the symbol
 * layers — this is an optimisation, not a dependency.
 */
export function buildTrainAtlas(index: NetworkIndex): TrainAtlas | null {
  const ratio = Math.min(3, Math.max(2, Math.round((globalThis.devicePixelRatio || 1) * SCALE)));
  const marks: { id: string; img: ImageData; ratio: number }[] = [];
  for (const route of Object.keys(index.net.routes)) {
    const ch = chevron(index.routeColor(route), ratio);
    if (ch) marks.push({ id: chevronId(route), img: ch, ratio });
    for (const state of ["plain", "hold", "parked"] as BulletState[]) {
      const b = bullet(route, index, state, BULLET_RATIO);
      if (b) marks.push({ id: bulletId(route, state), img: b, ratio: BULLET_RATIO });
    }
  }
  if (!marks.length) return null;

  marks.sort((a, b) => b.img.height - a.img.height);
  const placed = new Map<string, { x: number; y: number; w: number; h: number; ratio: number }>();
  let x = PAD, y = PAD, shelf = 0;
  for (const m of marks) {
    const { width: w, height: h } = m.img;
    if (x + w + PAD > ATLAS_WIDTH) { x = PAD; y += shelf + PAD; shelf = 0; }
    placed.set(m.id, { x, y, w, h, ratio: m.ratio });
    x += w + PAD;
    shelf = Math.max(shelf, h);
  }
  const height = y + shelf + PAD;

  const c = document.createElement("canvas");
  c.width = ATLAS_WIDTH;
  c.height = height;
  const g = c.getContext("2d", { willReadFrequently: true });
  if (!g) return null;
  for (const m of marks) {
    const at = placed.get(m.id)!;
    g.putImageData(m.img, at.x, at.y);
  }
  const image = g.getImageData(0, 0, ATLAS_WIDTH, height);
  const rects = new Map<string, AtlasRect>();
  for (const [id, at] of placed) {
    rects.set(id, {
      u0: at.x / ATLAS_WIDTH, v0: at.y / height,
      u1: (at.x + at.w) / ATLAS_WIDTH, v1: (at.y + at.h) / height,
      w: at.w / at.ratio, h: at.h / at.ratio,
    });
  }
  return { image, width: ATLAS_WIDTH, height, rect: (id) => rects.get(id) };
}

/** Register a chevron and a bullet per service, in each state; safe to call more than once. */
export function addRouteIcons(map: MapLibreMap, index: NetworkIndex) {
  const ratio = Math.min(3, Math.max(2, Math.round((globalThis.devicePixelRatio || 1) * SCALE)));
  for (const route of Object.keys(index.net.routes)) {
    const id = chevronId(route);
    if (!map.hasImage(id)) {
      // A chevron sits on the map, on black, so it takes the colour the line does.
      const img = chevron(index.routeColor(route), ratio);
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
