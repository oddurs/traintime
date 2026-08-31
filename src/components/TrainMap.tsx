"use client";

import { useEffect, useRef } from "react";
import * as maplibregl from "maplibre-gl";
import type { GeoJSONSource, MapMouseEvent } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { LonLat, Selection, TrainPosition, TrainState } from "@/lib/types";
import { NetworkIndex } from "@/lib/network";
import { Kinematics } from "@/lib/kinematics";
import { addRouteIcons, chevronId } from "@/lib/icons";
import { asset } from "@/lib/basePath";
import { readHash } from "@/lib/urlState";

const STYLE = "https://tiles.openfreemap.org/styles/dark";
// MapLibre's module worker URL doesn't survive Next's bundler; serve a copy from /public instead
// (see the prepare:assets script in package.json).
maplibregl.setWorkerUrl(asset("/maplibre/maplibre-gl-worker.mjs"));

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

/**
 * One feature per continuous stroke: a route's segments chained together while they keep the
 * same lane, so a line joining or leaving a shared corridor is drawn as one unbroken curve with
 * a rounded end, instead of a series of butt-ended pieces.
 */
function routeLines(index: NetworkIndex): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (const [route, runs] of Object.entries(index.net.routeRuns)) {
    const r = index.net.routes[route];
    if (!r) continue;
    for (const run of runs) {
      const coordinates: LonLat[] = [];
      for (let i = 0; i + 1 < run.stops.length; i++) {
        const u = run.stops[i], v = run.stops[i + 1];
        const seg = index.net.segments[u < v ? `${u}-${v}` : `${v}-${u}`];
        if (!seg) continue;
        const piece = u < v ? seg : [...seg].reverse();
        for (const p of piece) {
          const last = coordinates[coordinates.length - 1];
          if (!last || last[0] !== p[0] || last[1] !== p[1]) coordinates.push(p);
        }
      }
      if (coordinates.length < 2) continue;
      features.push({
        type: "Feature",
        properties: { route, color: r.color, slot: run.slot, shared: run.shared },
        geometry: { type: "LineString", coordinates },
      });
    }
  }
  return { type: "FeatureCollection", features };
}

function stationPoints(index: NetworkIndex): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: Object.values(index.net.stations).map((s) => ({
      type: "Feature",
      properties: { id: s.id, name: s.name },
      geometry: { type: "Point", coordinates: [s.lon, s.lat] },
    })),
  };
}

export default function TrainMap(props: Props) {
  const { index, statesRef, positionsRef, clock, speed, visibleRoutes, showRibbons, selection, onSelect,
    follow, onFollowEnd, highlight, focusKey, fitRoute, onView, reducedMotion, minimal } = props;

  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const kinRef = useRef<Kinematics | null>(null);
  const readyRef = useRef(false);
  const layersRef = useRef(false);

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
      for (const p of trains) {
        if (vis && !vis.has(p.route)) continue;
        const r = idx.net.routes[p.route];
        const selected = sel.kind === "train" && sel.id === p.id;
        const moving = p.phase === "moving" && p.speed > 0.6;
        points.push({
          type: "Feature",
          properties: {
            id: p.id, route: p.route, label: p.route.replace(/X$/, "").slice(0, 2),
            color: r?.color ?? "#808183", textColor: r?.textColor ?? "#ffffff",
            ghost: p.phase === "unstarted" || !p.state.assigned,
            holding: p.motion === "holding", moving, bearing: Math.round(p.bearing),
            chevron: chevronId(p.route), selected, highlighted: hi.has(p.id),
          },
          geometry: { type: "Point", coordinates: [p.lon, p.lat] },
        });
        if (p.ribbon && p.ribbon.length >= 2 && (ribbons || selected)) {
          bands.push({
            type: "Feature",
            properties: { color: selected ? "#ffffff" : (r?.color ?? "#808183") },
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
      map.addSource("stations", { type: "geojson", data: stationPoints(index) });
      map.addSource("ribbons", { type: "geojson", data: EMPTY });
      map.addSource("trains", { type: "geojson", data: EMPTY });
      map.addSource("focus", { type: "geojson", data: EMPTY });

      map.addLayer({
        id: "routes-casing", type: "line", source: "routes",
        layout: { "line-cap": "round", "line-join": "round", "line-miter-limit": 1.4 },
        paint: {
          "line-color": "#000", "line-opacity": 0.75,
          "line-width": ["interpolate", ["linear"], ["zoom"], 10, 2.3, 13, 3.9, 16, 6.6],
        },
      });
      map.addLayer({
        id: "routes-line", type: "line", source: "routes",
        layout: { "line-cap": "round", "line-join": "round", "line-miter-limit": 1.4 },
        paint: {
          "line-color": ["get", "color"], "line-opacity": 0.95,
          "line-width": ["interpolate", ["linear"], ["zoom"], 10, 1.1, 13, 2.3, 16, 4.2],
        },
      });
      map.addLayer({
        id: "focus-ring", type: "circle", source: "focus",
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 10, 14, 20],
          "circle-color": "rgba(255,255,255,0.08)", "circle-stroke-color": "#fff", "circle-stroke-width": 2, "circle-stroke-opacity": 0.9,
        },
      });
      map.addLayer({
        id: "stations", type: "circle", source: "stations", minzoom: 12,
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, 1.4, 14, 2.8, 16, 4.5],
          "circle-color": "#0b0b0d",
          "circle-stroke-color": "#c9c9d2",
          "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 12, 1, 16, 1.6],
          "circle-opacity": 1,
          "circle-stroke-opacity": ["interpolate", ["linear"], ["zoom"], 12, 0.5, 14, 0.9],
        },
      });
      map.addLayer({
        id: "station-labels", type: "symbol", source: "stations", minzoom: 13.5,
        layout: { "text-field": ["get", "name"], "text-font": ["Noto Sans Regular"], "text-size": 11, "text-offset": [0, 0.9], "text-anchor": "top", "text-optional": true },
        paint: { "text-color": "#cfcfcf", "text-halo-color": "#000", "text-halo-width": 1.2 },
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
          "circle-stroke-color": ["case", ["get", "selected"], "#ffffff", "#9fd0ff"],
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
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 4.5, 14, 9],
          "circle-color": ["get", "color"],
          "circle-opacity": ["case", ["get", "ghost"], 0.4, 1],
          "circle-stroke-color": ["case", ["get", "holding"], "#ffb454", "#ffffff"],
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
    };
    if (readyRef.current) add();
    else map.once("style.load", add);
  }, [index]);

  // --- route visibility
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !layersRef.current || !index) return;
    const list = visibleRoutes ? [...visibleRoutes] : Object.keys(index.net.routes);
    const filter: maplibregl.FilterSpecification = ["in", ["get", "route"], ["literal", list]];
    map.setFilter("routes-line", filter);
    map.setFilter("routes-casing", filter);
  }, [visibleRoutes, index]);

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
    map.fitBounds(b, { padding: { top: 60, bottom: 60, left: minimal ? 60 : 340, right: 60 }, duration: reducedMotion ? 0 : 900 });
  }, [fitRoute, index, minimal, reducedMotion]);

  return <div ref={containerRef} className="map" />;
}
