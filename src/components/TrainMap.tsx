"use client";

import { useEffect, useRef } from "react";
import * as maplibregl from "maplibre-gl";
import type { GeoJSONSource, MapMouseEvent } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { TrainPosition, TrainState } from "@/lib/types";
import { NetworkIndex, parentOf } from "@/lib/network";
import { Kinematics } from "@/lib/kinematics";
import { asset } from "@/lib/basePath";

const STYLE = "https://tiles.openfreemap.org/styles/dark";
// MapLibre's module worker URL doesn't survive Next's bundler; serve a copy from /public instead
// (see the prepare:maplibre script in package.json).
maplibregl.setWorkerUrl(asset("/maplibre/maplibre-gl-worker.mjs"));

interface Props {
  index: NetworkIndex;
  statesRef: React.RefObject<Map<string, TrainState>>;
  clock: () => number;
  speed: number;
  visibleRoutes: Set<string>;
  showRibbons: boolean;
}

function routeLines(index: NetworkIndex): GeoJSON.FeatureCollection {
  const net = index.net;
  const routes = Object.values(net.routes).sort((a, b) => b.sortOrder - a.sortOrder);
  return {
    type: "FeatureCollection",
    features: routes
      .filter((r) => net.routeSegments[r.id]?.length)
      .map((r) => ({
        type: "Feature",
        properties: { route: r.id, color: r.color },
        geometry: { type: "MultiLineString", coordinates: net.routeSegments[r.id].map((k) => net.segments[k]) },
      })),
  };
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

function trainFeatures(index: NetworkIndex, trains: TrainPosition[], visible: Set<string>, ribbons: boolean) {
  const points: GeoJSON.Feature[] = [];
  const bands: GeoJSON.Feature[] = [];
  for (const t of trains) {
    if (!visible.has(t.route)) continue;
    const r = index.net.routes[t.route];
    const color = r?.color ?? "#808183";
    points.push({
      type: "Feature",
      id: t.id,
      properties: {
        id: t.id, route: t.route, label: t.route.replace(/X$/, "").slice(0, 2), color,
        textColor: r?.textColor ?? "#ffffff", phase: t.phase, motion: t.motion, assigned: t.state.assigned,
      },
      geometry: { type: "Point", coordinates: [t.lon, t.lat] },
    });
    if (ribbons && t.ribbon && t.ribbon.length >= 2) {
      bands.push({ type: "Feature", properties: { color }, geometry: { type: "LineString", coordinates: t.ribbon } });
    }
  }
  return {
    points: { type: "FeatureCollection", features: points } as GeoJSON.FeatureCollection,
    bands: { type: "FeatureCollection", features: bands } as GeoJSON.FeatureCollection,
  };
}

function fmtIn(secs: number): string {
  if (secs < 20) return "now";
  const m = secs / 60;
  return m < 1 ? `${Math.round(secs)} s` : `${m.toFixed(m < 10 ? 1 : 0)} min`;
}

function fmtClock(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit", second: "2-digit" });
}

function popupHtml(index: NetworkIndex, t: TrainPosition, now: number): string {
  const st = t.state;
  const r = index.net.routes[t.route];
  const dest = st.stops.length ? index.stationName(st.stops[st.stops.length - 1].id) : "?";
  const next = index.stationName(st.nextStop);
  let where: string;
  if (st.phase === "dwelling") {
    const dwelt = Math.max(0, Math.round(now - (st.arrivedAt ?? now)));
    const leaves = st.expectedDeparture !== undefined ? st.expectedDeparture - now : undefined;
    where = `At ${next} · ${dwelt} s${leaves !== undefined ? ` · leaves ${leaves > 5 ? `in ${Math.round(leaves)} s` : "now"}` : ""}`;
  }
  else if (st.phase === "unstarted") where = `Not yet departed · leaves ${next} ${fmtIn(st.eta - now)}`;
  else {
    const pct = t.length > 0 ? Math.round((100 * t.s) / t.length) : 0;
    const kmh = Math.round(t.speed * 3.6);
    const motion = t.motion === "holding" ? (st.leaderId ? "holding behind train ahead" : "holding at signal") : t.motion;
    where = `${index.stationName(st.prevStop ?? "")} → ${next} · ${pct}% · ${kmh} km/h · ${motion} · arrives ${fmtIn(st.eta - now)}`;
  }
  const rows = st.stops
    .slice(0, 6)
    .map((s) => {
      const drift = Math.round(s.eta - s.etaRaw);
      const driftTxt = Math.abs(drift) >= 5 ? `<i>(MTA ${drift > 0 ? "+" : ""}${-drift} s)</i>` : "";
      return `<li><span>${index.stationName(s.id)}</span><em>${fmtIn(s.eta - now)} <small>±${Math.round(s.sigma)} s</small>${driftTxt}</em></li>`;
    })
    .join("");
  const meta = [
    st.trainId ? `train ${st.trainId}` : st.id,
    st.direction === "N" ? "northbound" : "southbound",
    st.track ? `track ${st.track}` : "",
    st.assigned ? "" : "unassigned",
    st.departedAt ? `left ${fmtClock(st.departedAt)}${st.departedEstimated ? "~" : ""}` : "",
  ].filter(Boolean).join(" · ");
  return `
    <div class="tt-popup">
      <div class="tt-popup-head">
        <span class="tt-bullet" style="background:${r?.color ?? "#808183"};color:${r?.textColor ?? "#fff"}">${t.route}</span>
        <div><div class="tt-dest">to ${dest}</div><div class="tt-state">${where}</div></div>
      </div>
      <ul class="tt-stops">${rows}</ul>
      <div class="tt-id">${meta}</div>
    </div>`;
}

export default function TrainMap({ index, statesRef, clock, speed, visibleRoutes, showRibbons }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const kinRef = useRef<Kinematics | null>(null);
  const visibleRef = useRef(visibleRoutes);
  const ribbonsRef = useRef(showRibbons);
  const clockRef = useRef(clock);
  const speedRef = useRef(speed);
  const latestRef = useRef<TrainPosition[]>([]);
  const selectedRef = useRef<string | null>(null);
  const popupRef = useRef<maplibregl.Popup | null>(null);
  const readyRef = useRef(false);

  useEffect(() => { visibleRef.current = visibleRoutes; }, [visibleRoutes]);
  useEffect(() => { ribbonsRef.current = showRibbons; }, [showRibbons]);
  useEffect(() => { clockRef.current = clock; }, [clock]);
  useEffect(() => { speedRef.current = speed; }, [speed]);

  useEffect(() => {
    if (!containerRef.current) return;
    const kin = new Kinematics(index);
    kinRef.current = kin;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: STYLE,
      center: [-73.955, 40.735],
      zoom: 11.4,
      minZoom: 9.5,
      maxZoom: 17,
      attributionControl: { compact: true },
    });
    mapRef.current = map;
    if (process.env.NODE_ENV !== "production") {
      (window as unknown as { __tt?: unknown }).__tt = { map, kin, statesRef, index };
    }
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");

    map.once("style.load", () => {
      map.addSource("routes", { type: "geojson", data: routeLines(index) });
      map.addSource("stations", { type: "geojson", data: stationPoints(index) });
      map.addSource("ribbons", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addSource("trains", { type: "geojson", data: { type: "FeatureCollection", features: [] } });

      map.addLayer({
        id: "routes-casing", type: "line", source: "routes",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#000", "line-opacity": 0.5, "line-width": ["interpolate", ["linear"], ["zoom"], 10, 3, 14, 8] },
      });
      map.addLayer({
        id: "routes-line", type: "line", source: "routes",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": ["get", "color"], "line-opacity": 0.9, "line-width": ["interpolate", ["linear"], ["zoom"], 10, 1.4, 14, 4.5] },
      });
      map.addLayer({
        id: "stations", type: "circle", source: "stations", minzoom: 11.5,
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 11.5, 1.5, 14, 4, 16, 6],
          "circle-color": "#f2f2f2", "circle-stroke-color": "#111", "circle-stroke-width": 1,
          "circle-opacity": ["interpolate", ["linear"], ["zoom"], 11.5, 0.5, 13, 1],
        },
      });
      map.addLayer({
        id: "station-labels", type: "symbol", source: "stations", minzoom: 13.5,
        layout: { "text-field": ["get", "name"], "text-font": ["Noto Sans Regular"], "text-size": 11, "text-offset": [0, 0.9], "text-anchor": "top", "text-optional": true },
        paint: { "text-color": "#cfcfcf", "text-halo-color": "#000", "text-halo-width": 1.2 },
      });
      map.addLayer({
        id: "ribbons", type: "line", source: "ribbons",
        layout: { "line-cap": "round" },
        paint: { "line-color": ["get", "color"], "line-opacity": 0.28, "line-width": ["interpolate", ["linear"], ["zoom"], 10, 6, 14, 14], "line-blur": 2 },
      });
      map.addLayer({
        id: "trains", type: "circle", source: "trains",
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 4.5, 14, 9],
          "circle-color": ["get", "color"],
          "circle-opacity": ["case", ["get", "assigned"], 1, 0.45],
          "circle-stroke-color": ["case", ["==", ["get", "motion"], "holding"], "#ffb454", "#fff"],
          "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 10, 1, 14, 2],
          "circle-stroke-opacity": ["case", ["get", "assigned"], 1, 0.5],
        },
      });
      map.addLayer({
        id: "train-labels", type: "symbol", source: "trains", minzoom: 11.5,
        layout: { "text-field": ["get", "label"], "text-font": ["Noto Sans Bold"], "text-size": ["interpolate", ["linear"], ["zoom"], 11.5, 8, 14, 11], "text-allow-overlap": true, "text-ignore-placement": true },
        paint: { "text-color": ["get", "textColor"], "text-opacity": ["case", ["get", "assigned"], 1, 0.6] },
      });

      map.on("mouseenter", "trains", () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", "trains", () => (map.getCanvas().style.cursor = ""));
      map.on("click", "trains", (e: MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
        const f = e.features?.[0];
        if (!f) return;
        selectedRef.current = String(f.properties?.id);
        popupRef.current?.remove();
        const t = latestRef.current.find((x) => x.id === selectedRef.current);
        if (!t) return;
        popupRef.current = new maplibregl.Popup({ closeButton: true, maxWidth: "320px", offset: 12 })
          .setLngLat([t.lon, t.lat])
          .setHTML(popupHtml(index, t, clockRef.current()))
          .addTo(map);
        popupRef.current.on("close", () => (selectedRef.current = null));
      });
      readyRef.current = true;
    });

    let raf = 0;
    let last = performance.now();
    let lastPopupRefresh = 0;
    const frame = (ts: number) => {
      raf = requestAnimationFrame(frame);
      const dtWall = Math.min(0.25, (ts - last) / 1000);
      last = ts;
      if (!readyRef.current || !kinRef.current) return;
      const now = clockRef.current();
      const trains = kinRef.current.step([...statesRef.current.values()], now, dtWall * speedRef.current);
      latestRef.current = trains;
      const { points, bands } = trainFeatures(index, trains, visibleRef.current, ribbonsRef.current);
      (map.getSource("trains") as GeoJSONSource | undefined)?.setData(points);
      (map.getSource("ribbons") as GeoJSONSource | undefined)?.setData(bands);
      if (selectedRef.current && popupRef.current) {
        const t = trains.find((x) => x.id === selectedRef.current);
        if (t) {
          popupRef.current.setLngLat([t.lon, t.lat]);
          if (ts - lastPopupRefresh > 1000) {
            popupRef.current.setHTML(popupHtml(index, t, now));
            lastPopupRefresh = ts;
          }
        } else popupRef.current.remove();
      }
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      map.remove();
      mapRef.current = null;
      readyRef.current = false;
    };
  }, [index, statesRef]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    const filter: maplibregl.FilterSpecification = ["in", ["get", "route"], ["literal", [...visibleRoutes]]];
    map.setFilter("routes-line", filter);
    map.setFilter("routes-casing", filter);
  }, [visibleRoutes]);

  return <div ref={containerRef} className="map" />;
}

export { parentOf };
