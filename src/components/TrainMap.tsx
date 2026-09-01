"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import type { GeoJSONSource, MapMouseEvent } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { LonLat, Selection, TrainPosition, TrainState } from "@/lib/types";
import { NetworkIndex, fanAt, bandOffsetExpression, metresPerPixel } from "@/lib/network";
import { Kinematics } from "@/lib/kinematics";
import { addRouteIcons, chevronId } from "@/lib/icons";
import { STALLED_S } from "@/lib/format";
import { paint } from "@/lib/mapTheme";
import { asset } from "@/lib/basePath";
import { readHash } from "@/lib/urlState";

const STYLE = "https://tiles.openfreemap.org/styles/dark";
// MapLibre's module worker URL doesn't survive Next's bundler; serve a copy from /public instead
// (see the prepare:assets script in package.json).
maplibregl.setWorkerUrl(asset("/maplibre/maplibre-gl-worker.mjs"));

/** Band levels the weave is drawn in; matches zOf() in scripts/build-network.ts. */
const WEAVE_LEVELS = 5;

/**
 * How far a band sits from its corridor's centreline, in pixels. The true spacing is already in
 * the geometry; this is the extra separation that makes services legible, and it is the same
 * curve the trains are placed on so a train can never drift off its own line.
 */
const bandOffset = (scale: number) => bandOffsetExpression(scale) as unknown as maplibregl.DataDrivenPropertyValueSpecification<number>;

/** Shared with the train layer so both read one number. */
const fanScale = { current: 1 };

/**
 * A train's drawn position: its place along the track, shifted into its own band by exactly the
 * amount the line beside it is shifted.
 *
 * A train standing at a platform has no segment to take a band from, so it keeps the one it was
 * riding — without that it would hop to the middle of the corridor every time it stopped.
 */
function fanned(p: TrainPosition, index: NetworkIndex, fan: { colour: number; metric: number }, last: Map<string, [number, number]>): LonLat {
  const prev = p.state.prevStop, next = p.state.nextStop;
  const live = prev && next ? index.lateralBand(p.route, prev, next) : undefined;
  if (live) last.set(p.id, [live.cb, live.mb]);
  const band = live ? [live.cb, live.mb] : last.get(p.id);
  if (!band) return [p.lon, p.lat];
  const metres = band[0] * fan.colour + band[1] * fan.metric;
  if (metres === 0) return [p.lon, p.lat];
  // Right of the direction of travel, which is the side the line was offset to.
  const rad = ((p.bearing + 90) * Math.PI) / 180;
  const cos = Math.cos((p.lat * Math.PI) / 180) || 1e-6;
  return [p.lon + (Math.sin(rad) * metres) / (111_320 * cos), p.lat + (Math.cos(rad) * metres) / 111_320];
}

const NYC: [number, number] = [-73.955, 40.735];
/** Trains are re-uploaded to the GPU at this rate; motion is still integrated every frame. */
const DRAW_HZ = 30;

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
}

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

/** Every service, as strokes the renderer can offset. The cutting is the engine's business. */
function routeLines(index: NetworkIndex): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: index.strokes().map((s) => ({
      type: "Feature",
      properties: { route: s.route, color: s.colour, slot: s.slot, shared: s.shared, z: s.z, cb: s.cb, mb: s.mb },
      geometry: { type: "LineString", coordinates: s.pts },
    })),
  };
}

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
  const apply = (map: maplibregl.Map, index: NetworkIndex, visible: Set<string> | null, attempt = 0) => {
    if (!map.getLayer("routes-line-0")) return;
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
    const routeIn: maplibregl.FilterSpecification = ["in", ["get", "route"], ["literal", list]];
    const scale = visible && visible.size < all.length ? 1.6 : 1;
    for (let z = 0; z < WEAVE_LEVELS; z++) {
      const f: maplibregl.FilterSpecification = ["all", routeIn, ["==", ["get", "z"], z]];
      map.setFilter(`routes-line-${z}`, f);
      map.setFilter(`routes-casing-${z}`, f);
      if (scale !== applied.scale) {
        const offset = bandOffset(scale);
        map.setPaintProperty(`routes-line-${z}`, "line-offset", offset);
        map.setPaintProperty(`routes-casing-${z}`, "line-offset", offset);
      }
    }
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
    follow, onFollowEnd, highlight, focusKey, fitRoute, onView, reducedMotion, minimal } = props;

  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  // Holds the lane convention currently uploaded, so lines are only rebuilt when it changes.
  const applyVisibility = useMemo(() => applyVisibilityFactory({ scale: null, served: null }), []);
  /** The band each train was last riding, so one standing at a platform keeps its lane. */
  const lastBandRef = useRef(new Map<string, [number, number]>());
  const kinRef = useRef<Kinematics | null>(null);
  const readyRef = useRef(false);
  const layersRef = useRef(false);
  // Set once the map's own layers exist, so the effects that configure them know to run. Layers
  // are added from a map callback, which can happen after those effects have already fired.
  const [layersReady, setLayersReady] = useState(false);

  // Live props the animation loop reads without re-subscribing.
  const live = useRef({ visibleRoutes, showRibbons, selection, follow, highlight, clock, speed, index, onSelect, onFollowEnd });
  useEffect(() => {
    live.current = { visibleRoutes, showRibbons, selection, follow, highlight, clock, speed, index, onSelect, onFollowEnd };
  }, [visibleRoutes, showRibbons, selection, follow, highlight, clock, speed, index, onSelect, onFollowEnd]);

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

    map.once("style.load", () => { readyRef.current = true; });
    map.on("dragstart", () => { if (live.current.follow) live.current.onFollowEnd(); });
    map.on("moveend", () => {
      if (!onView) return;
      const c = map.getCenter();
      onView({ lat: c.lat, lon: c.lng, zoom: map.getZoom() });
    });

    let raf = 0;
    let last = performance.now();
    let lastDraw = 0;
    const frame = (ts: number) => {
      raf = requestAnimationFrame(frame);
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

      if (ts - lastDraw < 1000 / DRAW_HZ) return;
      lastDraw = ts;
      const { visibleRoutes: vis, showRibbons: ribbons, selection: sel, highlight: hi, follow: fol } = live.current;
      const points: GeoJSON.Feature[] = [];
      const bands: GeoJSON.Feature[] = [];
      // Trains are placed on the same fan the lines are drawn with. The renderer eases the lines
      // apart as a pixel offset, so the equivalent distance in metres is worked out for the zoom
      // being drawn and applied to each train — otherwise a train would sit on its line at one
      // zoom and beside it at every other.
      const zoom = map.getZoom();
      const m = metresPerPixel(zoom) * fanScale.current;
      const px = fanAt(zoom);
      const fan = { colour: px.colour * m, metric: px.metric * m };
      const lastBand = lastBandRef.current;
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
        const r = idx.net.routes[p.route];
        const selected = sel.kind === "train" && sel.id === p.id;
        const moving = p.phase === "moving" && p.speed > 0.6 && p.stalledFor < STALLED_S;
        const stackKey = p.phase === "moving" ? "" : `${p.route}|${p.state.nextStop}|${p.phase}`;
        const stacked = stackKey ? (stackAt.get(stackKey) ?? 1) : 1;
        if (stackKey && stacked > 1 && !selected) {
          if (drawn.has(stackKey)) continue;
          drawn.add(stackKey);
        }
        points.push({
          type: "Feature",
          properties: {
            id: p.id, route: p.route, label: p.route.replace(/X$/, "").slice(0, 2),
            color: r?.color ?? paint("--route-unknown"), textColor: r?.textColor ?? paint("--route-unknown-text"),
            ghost: p.phase === "unstarted" || !p.state.assigned || !!p.state.stale,
            // How long since the feed last revised anything about this train. A train the MTA has
            // not touched in forty minutes was being drawn exactly like one revised nine seconds
            // ago, which is a claim about freshness we cannot support.
            revised: Math.max(0, Math.round(t - (p.state.updatedAt ?? t))),
            // Amber means the train is not moving and we know why, or has not moved for minutes
            // and we may not. Either way it is the thing to notice about it.
            holding: p.motion === "holding" || p.stalledFor >= STALLED_S,
            stalled: p.stalledFor >= STALLED_S,
            moving, bearing: Math.round(p.bearing),
            chevron: chevronId(p.route), selected, highlighted: hi.has(p.id),
            // How many trains this marker stands for, and whether it is in service at all.
            stacked: selected ? 1 : stacked,
            parked: p.phase === "unstarted",
            atPlatform: p.phase === "dwelling",
          },
          geometry: { type: "Point", coordinates: fanned(p, idx, fan, lastBand) },
        });
        if (p.ribbon && p.ribbon.length >= 2 && (ribbons || selected)) {
          bands.push({
            type: "Feature",
            properties: { color: selected ? paint("--label") : (r?.color ?? paint("--route-unknown")) },
            geometry: { type: "LineString", coordinates: p.ribbon },
          });
        }
        if (fol && selected) map.setCenter([p.lon, p.lat]);
      }
      (map.getSource("trains") as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: points });
      (map.getSource("ribbons") as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: bands });
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
      addRouteIcons(map, index);

      map.addSource("routes", { type: "geojson", data: routeLines(index) });
      map.addSource("stations", { type: "geojson", data: stationPoints(index, null) });
      map.addSource("ribbons", { type: "geojson", data: EMPTY });
      map.addSource("trains", { type: "geojson", data: EMPTY });
      map.addSource("focus", { type: "geojson", data: EMPTY });

      // The weave. One casing-and-line pair per band level, lowest first, so a band crossing over
      // another has its own black casing drawn on top of the line beneath — which is what makes a
      // crossing read as one line passing under another rather than as two lines merging. A single
      // casing layer under every line, as before, cannot do this: the casing is below both strokes,
      // so crossings came out flat.
      for (let z = 0; z < WEAVE_LEVELS; z++) {
        map.addLayer({
          id: `routes-casing-${z}`, type: "line", source: "routes",
          filter: ["==", ["get", "z"], z],
          layout: { "line-cap": "round", "line-join": "round", "line-miter-limit": 1.4 },
          paint: {
            "line-color": paint("--map-casing"), "line-opacity": 0.75,
            "line-width": ["interpolate", ["linear"], ["zoom"], 10, 2.3, 13, 3.9, 16, 6.6],
            "line-offset": bandOffset(1),
          },
        });
        map.addLayer({
          id: `routes-line-${z}`, type: "line", source: "routes",
          filter: ["==", ["get", "z"], z],
          layout: { "line-cap": "round", "line-join": "round", "line-miter-limit": 1.4 },
          paint: {
            "line-color": ["get", "color"], "line-opacity": 0.95,
            "line-width": ["interpolate", ["linear"], ["zoom"], 10, 1.1, 13, 2.3, 16, 4.2],
            "line-offset": bandOffset(1),
          },
        });
      }
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
        id: "train-highlight", type: "circle", source: "trains",
        filter: ["any", ["get", "highlighted"], ["get", "selected"]],
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 9, 14, 16],
          "circle-color": "rgba(0,0,0,0)",
          "circle-stroke-color": ["case", ["get", "selected"], paint("--label"), paint("--map-uncertain")],
          "circle-stroke-width": ["case", ["get", "selected"], 2.5, 1.5],
          "circle-stroke-opacity": 0.95,
        },
      });
      map.addLayer({
        id: "train-chevrons", type: "symbol", source: "trains",
        filter: ["get", "moving"],
        layout: {
          "icon-image": ["get", "chevron"],
          "icon-rotate": ["get", "bearing"],
          "icon-rotation-alignment": "map",
          "icon-allow-overlap": true, "icon-ignore-placement": true,
          "icon-size": ["interpolate", ["linear"], ["zoom"], 10, 0.42, 14, 0.85],
        },
        paint: { "icon-opacity": ["case", ["get", "ghost"], 0.35, 0.95] },
      });
      map.addLayer({
        id: "trains", type: "circle", source: "trains",
        paint: {
          "circle-radius": [
            "interpolate", ["linear"], ["zoom"],
            10, ["case", [">", ["get", "stacked"], 1], 5.5, 4.5],
            14, ["case", [">", ["get", "stacked"], 1], 11, 9],
          ],
          // A train not yet in service is drawn as an outline: it is here, but it is not running,
          // and a solid marker claims otherwise.
          "circle-color": ["case", ["get", "parked"], paint("--map-station-fill"), ["get", "color"]],
          // Full strength while the feed is still revising it; fading as the record goes quiet,
          // down to a train we are still drawing but no longer vouching for.
          "circle-opacity": ["case", ["get", "ghost"], 0.4,
            ["interpolate", ["linear"], ["get", "revised"], 600, 1, 2400, 0.45]],
          "circle-stroke-color": [
            "case",
            ["get", "holding"], paint("--map-hold"),
            ["get", "parked"], ["get", "color"],
            paint("--label"),
          ],
          // A zoom expression has to sit at the top level, so the per-feature choice goes inside it.
          "circle-stroke-width": [
            "interpolate", ["linear"], ["zoom"],
            10, ["case", ["get", "holding"], 1.8, 1],
            14, ["case", ["get", "holding"], 3, 2],
          ],
          "circle-stroke-opacity": ["case", ["get", "ghost"], 0.45, 1],
        },
      });
      map.addLayer({
        id: "train-stack", type: "symbol", source: "trains", minzoom: 12,
        filter: [">", ["get", "stacked"], 1],
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
      map.addLayer({
        id: "train-labels", type: "symbol", source: "trains", minzoom: 11.5,
        layout: {
          "text-field": ["get", "label"], "text-font": ["Noto Sans Bold"],
          "text-size": ["interpolate", ["linear"], ["zoom"], 11.5, 8, 14, 11],
          "text-allow-overlap": true, "text-ignore-placement": true,
        },
        paint: { "text-color": ["get", "textColor"], "text-opacity": ["case", ["get", "ghost"], 0.55, 1] },
      });

      const cursor = (on: boolean) => () => (map.getCanvas().style.cursor = on ? "pointer" : "");
      for (const id of ["trains", "stations", "station-labels"]) {
        map.on("mouseenter", id, cursor(true));
        map.on("mouseleave", id, cursor(false));
      }
      map.on("click", "trains", (e: MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
        const f = e.features?.[0];
        if (f) live.current.onSelect({ kind: "train", id: String(f.properties?.id) });
      });
      const pickStation = (e: MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
        if (map.queryRenderedFeatures(e.point, { layers: ["trains"] }).length) return;
        const f = e.features?.[0];
        if (f) live.current.onSelect({ kind: "station", id: String(f.properties?.id) });
      };
      map.on("click", "stations", pickStation);
      map.on("click", "station-labels", pickStation);
      map.on("click", (e) => {
        const hits = map.queryRenderedFeatures(e.point, { layers: ["trains", "stations", "station-labels"] });
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
    applyVisibility(map, index, visibleRoutes);
    // The fan narrows as you zoom into a corridor, so the layout is revisited when the zoom
    // settles. `zoomend` rather than `zoom`: re-laying mid-pinch would be wasted work, and the
    // width only ever changes at a band edge.
    const onZoom = () => applyVisibility(map, index, visibleRoutes);
    map.on("zoomend", onZoom);
    return () => { map.off("zoomend", onZoom); };
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
