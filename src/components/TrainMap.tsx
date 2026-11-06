"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { GeoJSONSource, Map as MapLibreMap, MapGeoJSONFeature, MapMouseEvent, Point } from "maplibre-gl";
import { maplibregl } from "@/lib/maplibre";
import "maplibre-gl/dist/maplibre-gl.css";
import { markTiming } from "@/lib/clientHealth";
import type { LonLat, Selection, TrainPosition, TrainState } from "@/lib/types";
import { NetworkIndex, fanAt, metresPerPixel } from "@/lib/network";
import { buildLineMesh, parseColour } from "@/lib/lineGeometry";
import { LineLayer } from "@/lib/lineLayer";
import { Kinematics } from "@/lib/kinematics";
import { addRouteIcons, buildTrainAtlas, bulletId, chevronId } from "@/lib/icons";
import { STRIDE, TrainLayer, mercatorPerMetre, mercatorX, mercatorY, writeMark } from "@/lib/trainLayer";
import { BOX } from "@/lib/roundel";
import { paint } from "@/lib/mapTheme";
import { readHash } from "@/lib/urlState";
import { frameTook, installFramePerf, perfOn, sourceUploaded } from "@/lib/framePerf";

const STYLE = "https://tiles.openfreemap.org/styles/dark";

/** Shared by the line layer and the train layer so both read one number. */
const fanScale = { current: 1 };
/**
 * The layer that draws the weave, reached from the visibility pass.
 *
 * A module-level holder rather than a ref because `applyVisibilityFactory` is built outside the
 * component, beside `fanScale`, which has the same shape for the same reason.
 */
const lineLayer: { current: LineLayer | null } = { current: null };

/**
 * The fan as a screen offset, in CSS pixels — the same sum the shader does, for the few things
 * MapLibre still draws by longitude and latitude.
 *
 * The trains do not use this: they carry their band into the vertex shader and are displaced with
 * the camera of the frame being drawn. What is left are the selection ring, the platform counts and
 * the hit test, and every one of those is read at a moment when the camera is settled — a click, or
 * a source rebuild on the geometry clock — so a formula evaluated here cannot be a frame stale in
 * the way the trains' was.
 *
 * It is still a second copy of the sum, and the way to be rid of it is to draw the ring and the
 * counts as instanced marks in the train layer, which is render-3.
 */
function fanOffsetPx(cb: number, mb: number, tangentRad: number, zoom: number, bearingRad: number, scale: number): [number, number] {
  const f = fanAt(zoom);
  const d = (cb * f.colour + mb * f.metric) * scale;
  if (d === 0) return [0, 0];
  // Right of the direction of travel, which is the side the line is offset to. Screen y runs down.
  const a = tangentRad + Math.PI / 2 - bearingRad;
  return [Math.sin(a) * d, -Math.cos(a) * d];
}

const NYC: [number, number] = [-73.955, 40.735];

/*
 * How often the map's GeoJSON sources are rebuilt, from how fast a train moves on screen.
 *
 * This used to govern the trains themselves, and that was the whole problem. Each update parsed
 * and tiled seven hundred features on a worker, so it was rationed — down to four times a second
 * at city zoom, which is what the stepping was. The trains are drawn from a buffer now and move at
 * the frame rate; what is left on this clock is the ribbons and the platform counts, which are
 * geometry rather than animation and cost the same as they always did.
 *
 * The rate follows the movement: rebuild about every 0.4 px a train travels, floored so the map
 * still answers a feed update promptly and capped so it never asks for more than a frame.
 */
const TRAIN_SPEED = 15;
const MOVE_PX = 0.4;
const MIN_HZ = 4;
const MAX_HZ = 30;
const drawInterval = (zoom: number, movePx = MOVE_PX) => {
  const pxPerSecond = TRAIN_SPEED / metresPerPixel(zoom);
  return 1000 / Math.max(MIN_HZ, Math.min(MAX_HZ, pxPerSecond / movePx));
};

/**
 * The ribbons' own clock: a step the width of their blur.
 *
 * They were on the 0.4 px clock above, which at street zoom is twenty uploads a second — more
 * than a throttled phone draws frames, so every frame re-tiled them on a worker, and that was half
 * the main thread: 38.6 ms a frame at zoom 16 on a 4× CPU, 14.5 with no ribbons at all. A ribbon
 * is a ±1σ band drawn at 30% opacity with a 3 px blur, and a step no wider than the blur does
 * not read as a step. About three a second at zoom 16.
 */
const RIBBON_MOVE_PX = 3;
/** Where the ribbon layer starts drawing; below it an upload is work nobody sees. */
const RIBBON_MINZOOM = 12.5;

export interface View { lat: number; lon: number; zoom: number }

interface Props {
  index: NetworkIndex | null;
  statesRef: React.RefObject<Map<string, TrainState>>;
  positionsRef: React.RefObject<Map<string, TrainPosition>>;
  clock: () => number;
  speed: number;
  /** null means "every route". */
  visibleRoutes: Set<string> | null;
  showRibbons: boolean;
  selection: Selection;
  onSelect: (s: Selection) => void;
  follow: boolean;
  onFollowEnd: () => void;
  highlight: Set<string>;
  /** Bump to (re-)frame the current selection. */
  focusKey: number;
  fitRoute: string | null;
  onView?: (v: View) => void;
  reducedMotion: boolean;
  minimal?: boolean;
  /** Called once, when the style has loaded and there is a map to look at. */
  onReady?: () => void;
}

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

/**
 * Stations, with the role each one plays.
 *
 * Every station used to be drawn as the same grey dot, which threw away most of what the system
 * is: 80 of them are the end of a line, 133 are interchanges where three or more services meet,
 * and one — Times Sq — is thirteen. The MTA's own map has had a vocabulary for this since 1970,
 * so this borrows it: a plain stop is a small dark tick on the line, an interchange is the larger
 * light circle, and a terminal carries an outer ring because the line stops there.
 *
 * `served` says whether any service currently shown actually calls here. Filtering to an express
 * leaves the stations it runs past but does not stop at, and those are dimmed rather than left
 * looking like somewhere you could get off.
 */
function stationPoints(index: NetworkIndex, visible: Set<string> | null): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: Object.values(index.net.stations).map((s) => {
      const routes = index.net.stationRoutes[s.id] ?? [];
      const n = index.servesCount(s.id);
      const terminal = index.terminalFor(s.id).length > 0;
      return {
        type: "Feature" as const,
        properties: {
          id: s.id, name: s.name, n, terminal,
          interchange: n >= 3,
          served: !visible || routes.some((r) => visible.has(r)),
        },
        geometry: { type: "Point" as const, coordinates: [s.lon, s.lat] },
      };
    }),
  };
}

/**
 * Filter the drawn services, and set how far the bands fan apart.
 *
 * The fan is a paint property, so the renderer eases it across zoom levels by itself and there is
 * nothing to re-lay. Narrowing to a handful of services is a request to tell them apart, so they
 * get more room.
 */
function applyVisibilityFactory(applied: { scale: number | null; served: string | null }) {
  const apply = (map: MapLibreMap, index: NetworkIndex, visible: Set<string> | null, attempt = 0) => {
    if (!lineLayer.current) return;
    // The layer can exist while the style is still settling its sprites and glyphs, and MapLibre
    // throws rather than queueing. Waiting for "idle" is no good here — the train layer updates
    // every frame, so this map never goes idle — so retry briefly instead. Without this, a filter
    // carried in a shared link is dropped and never reapplied.
    if (!map.isStyleLoaded()) {
      if (attempt < 40) setTimeout(() => apply(map, index, visible, attempt + 1), 150);
      return;
    }
    const all = Object.keys(index.net.routes);
    const list = visible ? [...visible] : all;
    const scale = visible && visible.size < all.length ? 1.6 : 1;
    /*
     * Filtering is a bitmask handed to the shader, and the widening is a number both shaders read
     * when they next draw. Neither touches a buffer, and neither is a paint property — which is
     * what eighteen `setFilter` and eighteen `setPaintProperty` calls used to be, each of them
     * re-evaluating an expression against every feature in every tile.
     */
    lineLayer.current.setVisible(visible);
    applied.scale = scale;
    fanScale.current = scale;
    // Stations a shown service runs past without stopping are dimmed rather than left looking
    // like somewhere you could get off — filter to an express and the local stops recede.
    const key = visible ? list.slice().sort().join(",") : "*";
    if (key !== applied.served) {
      applied.served = key;
      (map.getSource("stations") as GeoJSONSource | undefined)?.setData(stationPoints(index, visible));
    }
    if (process.env.NODE_ENV !== "production") {
      const w = window as unknown as { __tt?: Record<string, unknown> };
      w.__tt = { ...(w.__tt ?? {}), fanScale: scale, visibleCount: list.length };
    }
  };
  return apply;
}

export default function TrainMap(props: Props) {
  const { index, statesRef, positionsRef, clock, speed, visibleRoutes, showRibbons, selection, onSelect,
    follow, onFollowEnd, highlight, focusKey, fitRoute, onView, reducedMotion, minimal, onReady } = props;

  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  // Holds the lane convention currently uploaded, so lines are only rebuilt when it changes.
  const applyVisibility = useMemo(() => applyVisibilityFactory({ scale: null, served: null }), []);
  /** The band each train was last riding, so one standing at a platform keeps its lane. */
  const kinRef = useRef<Kinematics | null>(null);
  /*
   * The trains are drawn by trainLayer.ts rather than by a symbol layer. These hold the layer, the
   * instance buffer it is fed from — reused, never reallocated per frame — and where each train
   * was actually drawn, which is what a click has to be tested against now that the renderer no
   * longer keeps queryable features for them.
   */
  const trainLayerRef = useRef<TrainLayer | null>(null);
  const atlasRef = useRef<ReturnType<typeof buildTrainAtlas>>(null);
  const marksRef = useRef(new Float32Array(1024 * STRIDE));
  /**
   * What the last frame drew, as centreline position plus the band and tangent the shader fanned it
   * by — enough for the hit test to reconstruct the screen position without a second fan on the
   * frame path. `[lon, lat, cb, mb, tangentRad]`.
   */
  const drawnRef = useRef(new Map<string, [number, number, number, number, number]>());
  /** What the slow source last held, so labels are only rebuilt when they actually change. */
  const stackSigRef = useRef("");
  /** The rings last handed over, so an unchanged frame does not pay for a source update. */
  const ringSigRef = useRef("\u0000");
  const readyRef = useRef(false);
  const layersRef = useRef(false);
  // Set once the map's own layers exist, so the effects that configure them know to run. Layers
  // are added from a map callback, which can happen after those effects have already fired.
  const [layersReady, setLayersReady] = useState(false);

  // Live props the animation loop reads without re-subscribing.
  const live = useRef({ visibleRoutes, showRibbons, selection, follow, highlight, clock, speed, index, onSelect, onFollowEnd, onReady });
  useEffect(() => {
    live.current = { visibleRoutes, showRibbons, selection, follow, highlight, clock, speed, index, onSelect, onFollowEnd, onReady };
  }, [visibleRoutes, showRibbons, selection, follow, highlight, clock, speed, index, onSelect, onFollowEnd, onReady]);

  // --- map creation (once)
  useEffect(() => {
    if (!containerRef.current) return;
    // Shared links carry the camera in the hash; read it here so the map opens where it should.
    const start = readHash().view;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: STYLE,
      center: start ? [start.lon, start.lat] : NYC,
      zoom: start?.zoom ?? 11.4,
      minZoom: 9.5,
      maxZoom: 17,
      attributionControl: { compact: true },
    });
    mapRef.current = map;
    if (process.env.NODE_ENV !== "production") {
      (window as unknown as { __tt?: unknown }).__tt = { map, statesRef, positionsRef };
    }
    if (!minimal) map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");

    map.once("style.load", () => { readyRef.current = true; markTiming("map"); live.current.onReady?.(); });
    map.on("dragstart", () => { if (live.current.follow) live.current.onFollowEnd(); });
    map.on("moveend", () => {
      if (!onView) return;
      const c = map.getCenter();
      onView({ lat: c.lat, lon: c.lng, zoom: map.getZoom() });
    });

    installFramePerf();
    let raf = 0;
    let last = performance.now();
    let lastDraw = 0;
    let lastRibbon = 0;
    let ribbonsWereShown = false;
    /*
     * The callback is split in two so the work can be timed without a stopwatch threaded through
     * its early returns. `frame` re-arms and measures; `frameBody` is the work, unchanged.
     */
    const frame = (ts: number) => {
      raf = requestAnimationFrame(frame);
      if (!perfOn()) { frameBody(ts); return; }
      const t0 = performance.now();
      frameBody(ts);
      frameTook(performance.now() - t0);
    };
    const frameBody = (ts: number) => {
      // A hidden tab should cost nothing; the clock is absolute, so the first visible frame
      // simply picks the trains up where they should be by then.
      if (document.hidden) { last = ts; return; }
      const dt = Math.min(0.25, (ts - last) / 1000);
      last = ts;
      const { index: idx, clock: now, speed: sp } = live.current;
      if (!readyRef.current || !layersRef.current || !kinRef.current || !idx) return;
      const t = now();
      const trains = kinRef.current.step([...statesRef.current.values()], t, dt * sp);
      const positions = positionsRef.current;
      positions.clear();
      for (const p of trains) positions.set(p.id, p);

      /*
       * The marks are rebuilt every frame; the GeoJSON sources are not.
       *
       * This used to gate everything, because everything went through a source and a source update
       * is expensive. The trains no longer do — they are a buffer upload, rebuilt unconditionally
       * below — so the only things left on the old cadence are the ribbons and the platform counts,
       * which are geometry rather than animation and were never the reason the map looked slow.
       *
       * The gate used to read `map.isMoving() || …`, which meant every frame of every gesture was
       * due: 0.37 ribbon uploads a frame sitting still at city zoom and 0.98 through a drag, with
       * the main thread going from 6% to 15% busy scrolling in. That term was left over from when
       * this gate governed the trains, and holding *them* back through a pinch really did make them
       * swim off their lines. It does nothing for the two things still on this clock, because a
       * ribbon is `LonLat[]`: the camera moving does not change it, and MapLibre reprojects the
       * geometry it already has for free. A ribbon needs re-uploading when its train advances along
       * its path — a fact about time, which `drawInterval` already tracks — and never because
       * somebody dragged the map.
       *
       * (The trains do still swim, and that is real, but the cause is the fan being derived twice
       * from two readings of the camera rather than this clock. It is `render-2`, and no rebuild
       * rate fixes it.)
       */
      const geoDue = ts - lastDraw >= drawInterval(map.getZoom());
      if (geoDue) lastDraw = ts;
      const { visibleRoutes: vis, showRibbons: ribbons, selection: sel, highlight: hi, follow: fol } = live.current;
      // Ribbons are drawn above RIBBON_MINZOOM, for every train or just a selected one. Outside
      // that nothing is uploaded at all; on the way back in, they are drawn at once.
      const ribbonsShown = map.getZoom() >= RIBBON_MINZOOM && (ribbons || sel.kind === "train");
      const ribbonDue = ribbonsShown && (!ribbonsWereShown || ts - lastRibbon >= drawInterval(map.getZoom(), RIBBON_MOVE_PX));
      if (ribbonDue) lastRibbon = ts;
      const bands: GeoJSON.Feature[] = [];
      const rings: GeoJSON.Feature[] = [];
      const stacks: GeoJSON.Feature[] = [];
      let ringSig = "";
      const layer = trainLayerRef.current;
      const atlas = atlasRef.current;
      let marks = marksRef.current;
      let n = 0;
      const drawnPos = drawnRef.current;
      drawnPos.clear();
      // A speed in metres per second becomes a velocity in the frame the layer draws in. The
      // latitude barely varies across the city, so this is worked out once for the view.
      const mpu = mercatorPerMetre(map.getCenter().lat);
      /*
       * No fan is computed here any more.
       *
       * A train carries its band into the vertex shader, which does the sum in pixels against the
       * camera the frame is drawn with — the same camera, the same formula and the same instant as
       * the line beside it. What is left on this side is the band itself, which is a fact about the
       * network rather than about the view.
       *
       * The ring and the platform counts are still positioned by longitude and latitude, so they
       * are offset through `fanOffsetPx` below, using the map's own projection rather than an
       * approximation in metres. Both are read at moments when the camera is settled.
       */
      const zoom = map.getZoom();
      const bearingRad = (map.getBearing() * Math.PI) / 180;
      const fanScaleNow = fanScale.current;
      /** Centreline position, shifted into its band the way the shader will shift the train. */
      const fannedLonLat = (lon: number, lat: number, cb: number, mb: number, tanRad: number): LonLat => {
        const [dx, dy] = fanOffsetPx(cb, mb, tanRad, zoom, bearingRad, fanScaleNow);
        if (dx === 0 && dy === 0) return [lon, lat];
        const q = map.project([lon, lat]);
        const back = map.unproject([q.x + dx, q.y + dy]);
        return [back.lng, back.lat];
      };
      /*
       * Only the trains the camera can see.
       *
       * Every train in the system was being turned into a feature and handed to the renderer
       * thirty times a second, wherever the map happened to be looking. Parsing that took 55% of
       * the main thread on a throttled machine — nine hundred features a tick, of which, zoomed
       * into a neighbourhood, perhaps thirty were on screen.
       *
       * The margin is a full viewport on each side, so a train sliding in from off-screen is
       * already there when it arrives rather than appearing at the edge. At city zoom the box
       * holds everything and nothing is skipped, which is the right answer: at that zoom they
       * genuinely are all visible.
       */
      const view = map.getBounds();
      const padX = (view.getEast() - view.getWest());
      const padY = (view.getNorth() - view.getSouth());
      const west = view.getWest() - padX, east = view.getEast() + padX;
      const south = view.getSouth() - padY, north = view.getNorth() + padY;
      /*
       * Trains standing still at the same place, counted rather than stacked.
       *
       * A terminal holds a queue: nine 7 trains sit on one pixel at Flushing-Main St, eight 6s at
       * Pelham Bay Park. Drawing them one on top of another says "a train is here" nine times and
       * "there are nine" not at all — and the eight underneath cannot be clicked. One marker
       * carries the count instead. A train the viewer has selected is always drawn in its own
       * right, so selecting one never makes it vanish under the pile.
       */
      const stackAt = new Map<string, number>();
      for (const p of trains) {
        if (vis && !vis.has(p.route)) continue;
        if (p.phase === "moving") continue;
        const k = `${p.route}|${p.state.nextStop}|${p.phase}`;
        stackAt.set(k, (stackAt.get(k) ?? 0) + 1);
      }
      const drawn = new Set<string>();
      for (const p of trains) {
        if (vis && !vis.has(p.route)) continue;
        const selected = sel.kind === "train" && sel.id === p.id;
        // A selected train is drawn wherever it is: the panel is showing it, and its ribbon and
        // highlight have to exist for the camera to be able to fly to it.
        if (!selected && (p.lon < west || p.lon > east || p.lat < south || p.lat > north)) continue;
        const moving = p.phase === "moving" && p.speed > 0.6;
        const stackKey = p.phase === "moving" ? "" : `${p.route}|${p.state.nextStop}|${p.phase}`;
        const stacked = stackKey ? (stackAt.get(stackKey) ?? 1) : 1;
        if (stackKey && stacked > 1 && !selected) {
          if (drawn.has(stackKey)) continue;
          drawn.add(stackKey);
        }
        const shown = selected ? 1 : stacked;
        const [cb, mb] = p.band;
        // The track's own direction here, which is the basis the line is offset from. Not
        // `p.bearing`, which is rate-limited so the arrow sweeps through curves — see 0010.
        const tanRad = (p.tangent * Math.PI) / 180;
        // Centreline. The shader adds the fan, so nothing on this side needs the drawn position
        // except the hit test, which reconstructs it from these same numbers.
        const lon = p.lon, lat = p.lat;
        drawnPos.set(p.id, [lon, lat, cb, mb, tanRad]);

        if (atlas && layer) {
          // Room for a bullet and a chevron for every train left to consider.
          if ((n + 2) * STRIDE > marks.length) {
            const bigger = new Float32Array(marks.length * 2);
            bigger.set(marks);
            marks = marksRef.current = bigger;
          }
          const x = mercatorX(lon), y = mercatorY(lat);
          const rad = (p.bearing * Math.PI) / 180;
          // Where it will be, rather than where it was: the shader carries a train forward from
          // here, so a rebuild that arrives late still draws it in the right place.
          const v = moving ? p.speed * mpu : 0;
          const vx = Math.sin(rad) * v, vy = -Math.cos(rad) * v;
          // Not in service yet, or no longer to be trusted: drawn, but not vouched for.
          const status = p.state.status;
          const ghost = status === "scheduled" || status === "preparing" || status === "lost" || !p.state.assigned;
          const revised = Math.max(0, t - (p.state.updatedAt ?? t));

          const bullet = atlas.rect(bulletId(p.route, p.phase === "unstarted" ? "parked" : status === "held" ? "hold" : "plain"));
          if (bullet) {
            // Full strength while the feed is still revising it; fading as the record goes quiet,
            // down to a train we are still drawing but no longer vouching for.
            const fade = ghost ? 0.45 : 1 - 0.55 * Math.max(0, Math.min(1, (revised - 600) / 1800));
            const lo = bullet.w * (shown > 1 ? 13 : 11) / BOX;
            const hi = bullet.w * (shown > 1 ? 24 : 20) / BOX;
            writeMark(marks, n++, x, y, vx, vy, bullet, lo, lo, hi, hi, 0, fade, 0, tanRad, cb, mb);
          }
          if (moving) {
            const chev = atlas.rect(chevronId(p.route));
            // The chevron sits in the upper part of a taller mark, so turning it by the bearing
            // puts it ahead of the bullet without any offset of its own.
            if (chev) writeMark(marks, n++, x, y, vx, vy, chev,
              chev.w * 0.42, chev.h * 0.42, chev.w * 0.85, chev.h * 0.85, rad, ghost ? 0.35 : 0.95, 1,
              tanRad, cb, mb);
          }
        }

        if (selected || hi.has(p.id)) {
          const at = fannedLonLat(lon, lat, cb, mb, tanRad);
          rings.push({
            type: "Feature",
            properties: { selected },
            geometry: { type: "Point", coordinates: at },
          });
          // Accumulated here rather than walked again afterwards. Six decimals is about a tenth of
          // a metre, which is finer than a pixel at any zoom this map reaches — so a train that is
          // actually moving still registers every frame, and one standing at a platform does not.
          ringSig += `${selected ? "!" : ""}${at[0].toFixed(6)},${at[1].toFixed(6)};`;
        }
        if (geoDue && shown > 1) {
          stacks.push({
            type: "Feature",
            properties: { stacked: shown },
            geometry: { type: "Point", coordinates: fannedLonLat(lon, lat, cb, mb, tanRad) },
          });
        }
        if (ribbonDue && p.ribbon && p.ribbon.length >= 2 && (ribbons || selected)) {
          bands.push({
            type: "Feature",
            properties: { color: selected ? paint("--label") : idx.routeColor(p.route) },
            geometry: { type: "LineString", coordinates: p.ribbon },
          });
        }
        if (fol && selected) map.setCenter([p.lon, p.lat]);
      }
      if (layer) {
        layer.setMarks(marks, n, t);
        // A custom layer only draws when the map draws, and nothing else has changed.
        map.triggerRepaint();
      }
      /*
       * The ring has to keep up with the train it is drawn around, so it is not on the geometry
       * clock — but "keep up" is not the same as "every frame regardless".
       *
       * This was unconditional, and the justification at the time was that one or two features
       * stay cheap at the frame rate. The feature count was never the cost: a `setData` is a worker
       * round-trip, a re-parse and a source invalidation whatever it carries, and this asked for one
       * sixty times a second — measured at 1.00 uploads per frame in every scenario, idle included,
       * for geometry that only changes when something is selected.
       *
       * Nothing is selected most of the time, which is the case worth winning: the signature is
       * then the empty string every frame and the source is left alone entirely. With a selection
       * the ring does move, and then an upload is work that has to happen — until rings become
       * instanced marks in the train layer, which is `render-3`.
       */
      if (ringSig !== ringSigRef.current) {
        ringSigRef.current = ringSig;
        (map.getSource("trains") as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: rings });
        sourceUploaded("trains");
      }
      // Uploaded on their own clock; and once, empty, when they stop being shown, so what comes back
      // into view later is never a band left over from minutes ago.
      if (ribbonDue || (ribbonsWereShown && !ribbonsShown)) {
        (map.getSource("ribbons") as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: bands });
        sourceUploaded("ribbons");
      }
      ribbonsWereShown = ribbonsShown;
      if (geoDue) {
        // The counts sit at platforms and change only when a queue does, so they are handed over
        // when they differ rather than on a clock.
        const sig = `${Math.round(map.getZoom() * 10)}|${stacks.map((f) => `${f.properties!.stacked}@${(f.geometry as GeoJSON.Point).coordinates.join()}`).join(";")}`;
        if (sig !== stackSigRef.current) {
          stackSigRef.current = sig;
          (map.getSource("train-stacks") as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: stacks });
          sourceUploaded("train-stacks");
        }
      }
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      map.remove();
      mapRef.current = null;
      readyRef.current = false;
      layersRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- network-dependent layers, added as soon as the network arrives
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !index || layersRef.current) return;
    const add = () => {
      if (layersRef.current || !mapRef.current) return;
      layersRef.current = true;
      kinRef.current = new Kinematics(index);
      /*
       * The marks go into one texture of our own rather than MapLibre's image atlas: nothing draws
       * them as symbols any more. Where a canvas is unavailable the atlas comes back null and the
       * symbol layers are registered instead, so the map still draws — slowly, but at all.
       */
      const atlas = buildTrainAtlas(index);
      atlasRef.current = atlas;
      if (!atlas) addRouteIcons(map, index);

      map.addSource("stations", { type: "geojson", data: stationPoints(index, null) });
      map.addSource("ribbons", { type: "geojson", data: EMPTY });
      // Two sources, split by how often they change rather than by what they mean: the ring
      // follows a selected train every frame and is one feature; the counts sit at platforms and
      // change only when the queue does.
      map.addSource("trains", { type: "geojson", data: EMPTY });
      map.addSource("train-stacks", { type: "geojson", data: EMPTY });
      map.addSource("focus", { type: "geojson", data: EMPTY });

      /*
       * The weave, drawn by us.
       *
       * One casing-and-line pair per band level, lowest first, so a band crossing another has its
       * own casing drawn over the line beneath — which is what makes a crossing read as one line
       * passing under another rather than as two lines merging. That ordering is unchanged; what
       * changed is that it is eighteen draw calls over one static buffer instead of eighteen
       * GeoJSON layers over a source that was re-tiled as though the subway moved.
       *
       * The offset is the reason. These layers took the fan from an expression that sampled
       * `fanAt` at a list of zooms and drew chords between the samples, while the trains took it
       * from `fanAt` itself — so the gap between chord and curve was a train sitting off its own
       * line, four pixels of it at the zoom where a trunk splits. Both now call the same function
       * in the same pass from the same camera.
       */
      const mesh = buildLineMesh(index);
      const layer = new LineLayer(mesh, parseColour(paint("--map-casing")), () => fanScale.current);
      lineLayer.current = layer;
      map.addLayer(layer);
      map.addLayer({
        id: "focus-ring", type: "circle", source: "focus",
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 10, 14, 20],
          "circle-color": paint("--map-focus"), "circle-stroke-color": paint("--label"), "circle-stroke-width": 2, "circle-stroke-opacity": 0.9,
        },
      });
      map.addLayer({
        id: "station-terminals", type: "circle", source: "stations", minzoom: 12.5,
        filter: ["get", "terminal"],
        paint: {
          // The line ends here. An outer ring rather than a bigger dot, so a terminal that is
          // also an interchange reads as both.
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 12.5, 3.2, 14, 5.4, 16, 8],
          "circle-color": "rgba(0,0,0,0)",
          "circle-stroke-color": paint("--map-station-edge"),
          "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 12.5, 0.8, 16, 1.4],
          "circle-stroke-opacity": ["case", ["get", "served"], 0.75, 0.2],
        },
      });
      map.addLayer({
        id: "stations", type: "circle", source: "stations", minzoom: 12,
        paint: {
          // An interchange is drawn as the larger light circle the printed map uses; a plain stop
          // is a small dark tick on the line.
          "circle-radius": [
            "interpolate", ["linear"], ["zoom"],
            12, ["case", ["get", "interchange"], 2.2, 1.4],
            14, ["case", ["get", "interchange"], 4.2, 2.8],
            16, ["case", ["get", "interchange"], 6.4, 4.5],
          ],
          "circle-color": ["case", ["get", "interchange"], paint("--map-station-edge"), paint("--map-station-fill")],
          "circle-stroke-color": ["case", ["get", "interchange"], paint("--map-station-fill"), paint("--map-station-edge")],
          "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 12, 1, 16, 1.6],
          "circle-opacity": ["case", ["get", "served"], 1, 0.25],
          "circle-stroke-opacity": [
            "interpolate", ["linear"], ["zoom"],
            12, ["case", ["get", "served"], 0.5, 0.15],
            14, ["case", ["get", "served"], 0.9, 0.2],
          ],
        },
      });
      map.addLayer({
        id: "station-labels", type: "symbol", source: "stations", minzoom: 13.5,
        layout: {
          "text-field": ["get", "name"],
          "text-font": ["case", ["get", "interchange"], ["literal", ["Noto Sans Bold"]], ["literal", ["Noto Sans Regular"]]],
          "text-size": ["interpolate", ["linear"], ["zoom"], 13.5, ["case", ["get", "interchange"], 11, 10], 16, ["case", ["get", "interchange"], 13, 11]],
          "text-offset": [0, 0.9], "text-anchor": "top", "text-optional": true,
        },
        paint: {
          "text-color": ["case", ["get", "interchange"], paint("--label"), paint("--map-label")],
          "text-halo-color": paint("--map-halo"), "text-halo-width": 1.2,
          "text-opacity": ["case", ["get", "served"], 1, 0.35],
        },
      });
      map.addLayer({
        id: "ribbons", type: "line", source: "ribbons", minzoom: 12.5,
        layout: { "line-cap": "round" },
        paint: {
          "line-color": ["get", "color"],
          "line-opacity": ["interpolate", ["linear"], ["zoom"], 12.5, 0, 13.5, 0.3],
          "line-width": ["interpolate", ["linear"], ["zoom"], 12.5, 8, 16, 18],
          "line-blur": 3,
        },
      });
      map.addLayer({
        // No filter: the source now carries only the trains that should be ringed, rather than
        // every train with a flag on it. Leaving the old filter in place would have dropped a
        // highlighted-but-unselected train, whose flag no longer exists.
        id: "train-highlight", type: "circle", source: "trains",
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 9, 14, 16],
          "circle-color": "rgba(0,0,0,0)",
          "circle-stroke-color": ["case", ["get", "selected"], paint("--label"), paint("--map-uncertain")],
          "circle-stroke-width": ["case", ["get", "selected"], 2.5, 1.5],
          "circle-stroke-opacity": 0.95,
        },
      });
      /*
       * The trains themselves, drawn by trainLayer.ts.
       *
       * This was two symbol layers on a GeoJSON source. Moving a symbol means handing the source
       * new geometry, which re-tiles and rebuilds the buckets for every feature on a worker — so
       * the trains were repositioned four times a second to keep the cost down, and four times a
       * second is what stepping looks like. One instanced draw call from a buffer costs nothing
       * per frame, so they move at the frame rate instead.
       */
      if (atlas) {
        // The filter scale is read through a closure rather than passed as a number, so the layer
        // evaluates the fan against the zoom of the frame it is drawing.
        const layer = new TrainLayer(atlas, () => live.current.clock(), () => fanScale.current);
        trainLayerRef.current = layer;
        map.addLayer(layer);
      }
      map.addLayer({
        id: "train-stack", type: "symbol", source: "train-stacks", minzoom: 12,
        layout: {
          // "×4" beside the bullet: four trains are waiting here, not one.
          "text-field": ["concat", "×", ["to-string", ["get", "stacked"]]],
          "text-font": ["Noto Sans Bold"],
          "text-size": ["interpolate", ["linear"], ["zoom"], 12, 9, 15, 11],
          "text-offset": [1.1, -0.9], "text-anchor": "left",
          "text-allow-overlap": true, "text-ignore-placement": true,
        },
        paint: {
          "text-color": paint("--label"),
          "text-halo-color": paint("--map-halo"), "text-halo-width": 1.4,
        },
      });

      const cursor = (on: boolean) => () => (map.getCanvas().style.cursor = on ? "pointer" : "");
      for (const id of ["stations", "station-labels"]) {
        map.on("mouseenter", id, cursor(true));
        map.on("mouseleave", id, cursor(false));
      }

      /*
       * Which train is under the pointer.
       *
       * The renderer used to answer this: the trains were features in a symbol layer and
       * `queryRenderedFeatures` found them. They are instances in a buffer now, which nothing can
       * query, so the hit test is ours — over the positions the last frame actually drew, which is
       * the same set the eye is picking from, stacked trains included as the one mark that stands
       * for them.
       */
      const HIT_PX = 14;
      const pickTrain = (point: Point): string | null => {
        let best: string | null = null;
        let bestD = HIT_PX * HIT_PX;
        // The fan is the shader's now, so the drawn position has to be rebuilt here from the same
        // band and tangent it was drawn with. Once per pick rather than once per train per frame,
        // and at a moment when the camera is settled — a pointer is not a gesture.
        const zoom = map.getZoom();
        const bearingRad = (map.getBearing() * Math.PI) / 180;
        const scale = fanScale.current;
        for (const [id, at] of drawnRef.current) {
          const p = map.project([at[0], at[1]]);
          const [ox, oy] = fanOffsetPx(at[2], at[3], at[4], zoom, bearingRad, scale);
          const dx = p.x + ox - point.x, dy = p.y + oy - point.y;
          const d = dx * dx + dy * dy;
          if (d <= bestD) { bestD = d; best = id; }
        }
        return best;
      };

      // Hover runs on every pointer move, and the scan is over every train on screen — often a
      // few hundred. Ten times a second is past the point anyone can tell.
      let hoverAt = 0;
      let overTrain = false;
      map.on("mousemove", (e) => {
        const now = performance.now();
        if (now - hoverAt < 100) return;
        hoverAt = now;
        const over = pickTrain(e.point) !== null;
        if (over === overTrain) return;
        overTrain = over;
        if (over) map.getCanvas().style.cursor = "pointer";
        else if (!map.queryRenderedFeatures(e.point, { layers: ["stations", "station-labels"] }).length) {
          map.getCanvas().style.cursor = "";
        }
      });

      const pickStation = (e: MapMouseEvent & { features?: MapGeoJSONFeature[] }) => {
        // A train drawn over a station wins, the way it did when the renderer decided.
        if (pickTrain(e.point)) return;
        const f = e.features?.[0];
        if (f) live.current.onSelect({ kind: "station", id: String(f.properties?.id) });
      };
      map.on("click", "stations", pickStation);
      map.on("click", "station-labels", pickStation);
      map.on("click", (e) => {
        const train = pickTrain(e.point);
        if (train) return live.current.onSelect({ kind: "train", id: train });
        const hits = map.queryRenderedFeatures(e.point, { layers: ["stations", "station-labels"] });
        if (hits.length === 0) live.current.onSelect({ kind: "none" });
      });

      setLayersReady(true);
    };
    if (readyRef.current) add();
    else map.once("style.load", add);
  }, [index]);

  // --- route visibility, and the fan width that goes with it
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !layersReady || !index) return;
    // The fan widens when the map is narrowed to a few services, which is a function of the
    // filter and not of the zoom. This used to be re-applied on every `zoomend` as well, setting
    // the same filters and re-uploading the station source each time the camera settled, for a
    // width that had not changed.
    applyVisibility(map, index, visibleRoutes);
  }, [visibleRoutes, index, layersReady, applyVisibility]);

  // --- selection highlight and camera
  const selId = selection.kind === "none" ? "" : selection.id;
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !layersRef.current || !index) return;
    const focus = map.getSource("focus") as GeoJSONSource | undefined;
    if (selection.kind === "station") {
      const s = index.station(selection.id);
      if (s) {
        focus?.setData({ type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [s.lon, s.lat] } }] });
        const opts = { center: [s.lon, s.lat] as [number, number], zoom: Math.max(map.getZoom(), 13.5) };
        if (reducedMotion) map.jumpTo(opts); else map.flyTo({ ...opts, duration: 900, essential: true });
      }
      return;
    }
    focus?.setData(EMPTY);
    if (selection.kind === "train") {
      const p = positionsRef.current.get(selection.id);
      if (p) {
        const opts = { center: [p.lon, p.lat] as [number, number], zoom: Math.max(map.getZoom(), 13) };
        if (reducedMotion) map.jumpTo(opts); else map.flyTo({ ...opts, duration: 900, essential: true });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection.kind, selId, focusKey, index]);

  // --- zoom to a soloed route
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !layersRef.current || !index || !fitRoute) return;
    const keys = index.net.routeSegments[fitRoute] ?? [];
    if (!keys.length) return;
    const b = new maplibregl.LngLatBounds();
    for (const k of keys) for (const p of index.net.segments[k]) b.extend(p as [number, number]);
    // Pad around whatever the panel actually covers. On a phone it is a bottom sheet, not a left
    // panel, and asking for 340px of inset on a 390px viewport makes MapLibre refuse outright.
    const { width, height } = map.getCanvas().getBoundingClientRect();
    const narrow = width < 700;
    const pad = (v: number, extent: number) => Math.max(20, Math.min(v, extent / 2 - 40));
    map.fitBounds(b, {
      padding: {
        top: pad(48, height),
        bottom: pad(narrow && !minimal ? height * 0.42 : 48, height),
        left: pad(narrow || minimal ? 32 : 348, width),
        right: pad(48, width),
      },
      duration: reducedMotion ? 0 : 900,
    });
  }, [fitRoute, index, minimal, reducedMotion]);

  return <div ref={containerRef} className="map" />;
}
