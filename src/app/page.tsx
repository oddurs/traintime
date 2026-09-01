"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Panel from "@/components/Panel";
import type { Network, Selection, TrainPosition } from "@/lib/types";
import { NetworkIndex } from "@/lib/network";
import { useTrainStream, type StreamMode } from "@/lib/useTrainStream";
import { useIsMobile, useReducedMotion, useTicker } from "@/lib/hooks";
import { fetchAlerts, type AlertIndex } from "@/lib/alerts";
import { useGeolocation, useWakeLock } from "@/lib/geolocation";
import { nearestStations } from "@/lib/arrivals";
import { usePlaces } from "@/lib/places";
import { readHash, writeHash } from "@/lib/urlState";
import { asset } from "@/lib/basePath";
import type { View } from "@/components/TrainMap";

const TrainMap = dynamic(() => import("@/components/TrainMap"), { ssr: false });

/**
 * Hold the map back until the panel has painted.
 *
 * The map engine is 936 KB — three quarters of everything the app downloads — and although it is
 * already code-split, rendering it on the first pass puts its request in the same queue as the
 * ones the panel needs. Measured cold on a slow connection, nothing a rider could read appeared
 * for 32 seconds. Waiting a frame costs nothing anyone can perceive and lets the board come first,
 * which is the thing somebody standing on a platform actually opened the app for.
 */
function useDeferredMap(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const w = window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
    if (w.requestIdleCallback) { const h = w.requestIdleCallback(() => setReady(true), { timeout: 1500 }); return () => cancelIdleCallback(h); }
    const h = setTimeout(() => setReady(true), 120);
    return () => clearTimeout(h);
  }, []);
  return ready;
}

const ALERTS_EVERY = 120_000;

function App({ index }: { index: NetworkIndex | null }) {
  const [mode, setMode] = useState<StreamMode>({ kind: "live" });
  const [visible, setVisible] = useState<Set<string> | null>(null);
  const [showRibbons, setShowRibbons] = useState(true);
  const [selection, setSelection] = useState<Selection>({ kind: "none" });
  const [follow, setFollow] = useState(false);
  const [focusKey, setFocusKey] = useState(0);
  const [fitRoute, setFitRoute] = useState<string | null>(null);
  const [alerts, setAlerts] = useState<AlertIndex | null>(null);
  const [view, setView] = useState<View | undefined>(undefined);
  const [hydrated, setHydrated] = useState(false);
  const [nearby, setNearby] = useState(false);
  const [destination, setDestination] = useState<string | undefined>(undefined);
  const positionsRef = useRef(new Map<string, TrainPosition>());

  // Restore the state a shared link carries, once, before we start writing the hash back.
  useEffect(() => {
    const h = readHash();
    /* eslint-disable react-hooks/set-state-in-effect -- one-time restore from window.location, which render cannot read */
    if (h.replay) setMode({ kind: "replay", ...h.replay });
    if (h.routes) setVisible(new Set(h.routes));
    if (h.station) setSelection({ kind: "station", id: h.station });
    else if (h.train) { setSelection({ kind: "train", id: h.train }); setFollow(true); }
    if (h.view) setView(h.view);
    if (h.to) setDestination(h.to);
    setHydrated(true);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, []);

  const { statesRef, trains, feeds, status, clock } = useTrainStream(mode, index);
  const geo = useGeolocation(nearby);
  useWakeLock(follow);
  const { places, loaded: placesLoaded, toggle: togglePlace, touch: touchPlace, isSaved } = usePlaces();
  const mobile = useIsMobile();
  const reducedMotion = useReducedMotion();
  const now = useTicker(clock, 2);
  const wallNow = useTicker(() => Date.now() / 1000, 1);

  const byId = useMemo(() => new Map(trains.map((t) => [t.id, t])), [trains]);

  /*
   * Service alerts, refreshed slowly — they change on the order of minutes.
   *
   * Held back until the network index has arrived. The alert feed is 82 KB and the index is what
   * every board is drawn from; on a slow connection the two were competing for the same link and
   * the countdown a rider opened the app for was waiting behind a list of planned weekend
   * closures. Measured cold on a slow 4G connection, that was 13.6 seconds before anything
   * readable appeared.
   */
  useEffect(() => {
    if (!index) return;
    const ctl = new AbortController();
    const load = () => fetchAlerts(ctl.signal).then(setAlerts).catch(() => {});
    load();
    const id = setInterval(load, ALERTS_EVERY);
    return () => { ctl.abort(); clearInterval(id); };
  }, [index]);

  // Every view is a link.
  useEffect(() => {
    if (!hydrated) return;
    writeHash({
      station: selection.kind === "station" ? selection.id : undefined,
      train: selection.kind === "train" ? selection.id : undefined,
      to: destination,
      routes: visible ? [...visible] : undefined,
      view,
      replay: mode.kind === "replay" ? mode : undefined,
    });
  }, [hydrated, selection, visible, view, mode, destination]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (follow) setFollow(false);
      else setSelection({ kind: "none" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [follow]);

  // Following the viewer's location: the nearest station's board is what someone standing on a
  // platform actually wants. Any deliberate choice takes over and stops the following.
  const nearest = useMemo(
    () => (nearby && index && geo.lat !== undefined && geo.lon !== undefined
      ? nearestStations(index, geo.lat, geo.lon, 1)[0]
      : undefined),
    [nearby, index, geo.lat, geo.lon],
  );
  useEffect(() => {
    if (!nearest) return;
    /* eslint-disable react-hooks/set-state-in-effect -- responds to the device's position, an external signal */
    setSelection((cur) => (cur.kind === "station" && cur.id === nearest.id ? cur : { kind: "station", id: nearest.id }));
    setFocusKey((k) => k + 1);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [nearest]);

  // A commuter opens the app to see their own station. With a location, that is the nearest
  // saved one; without, the one they looked at last. Only when nothing was asked for by URL.
  const [autoOpened, setAutoOpened] = useState(false);
  useEffect(() => {
    if (!hydrated || !placesLoaded || autoOpened || !index) return;
    /* eslint-disable react-hooks/set-state-in-effect -- restores a stored preference once, after the URL has had its say */
    if (selection.kind !== "none" || places.length === 0) { setAutoOpened(true); return; }
    const best = geo.lat !== undefined && geo.lon !== undefined
      ? [...places].sort((a, b) => {
          const d = (p: typeof a) => {
            const st = index.station(p.id);
            return st ? Math.hypot(st.lat - geo.lat!, st.lon - geo.lon!) : Infinity;
          };
          return d(a) - d(b);
        })[0]
      : [...places].sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0];
    if (best) setSelection({ kind: "station", id: best.id });
    setAutoOpened(true);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [hydrated, placesLoaded, autoOpened, index, selection.kind, places, geo.lat, geo.lon]);

  // Remember which station was looked at, so the saved list can lead with it next time.
  useEffect(() => {
    if (selection.kind === "station") touchPlace(selection.id);
  }, [selection, touchPlace]);

  const select = useCallback((s: Selection) => {
    setSelection((cur) => {
      // Changing where you are starting from ends the old journey: keeping the destination gives
      // an empty board that reads like broken data rather than a finished trip.
      if (s.kind === "station" && !(cur.kind === "station" && cur.id === s.id)) setDestination(undefined);
      return s;
    });
    setFollow(false);
    setNearby(false);
    setFocusKey((k) => k + 1);
  }, []);

  const onToggle = useCallback((route: string, solo: boolean) => {
    if (solo) {
      setVisible(new Set([route]));
      setFitRoute(route);
      setTimeout(() => setFitRoute(null), 100);
      return;
    }
    setVisible((v) => {
      const all = new Set(Object.keys(index?.net.routes ?? {}));
      const next = new Set(v ?? all);
      if (next.has(route)) next.delete(route);
      else next.add(route);
      return next.size === all.size ? null : next;
    });
  }, [index]);

  const onAll = useCallback((on: boolean) => setVisible(on ? null : new Set()), []);

  // Distance to whatever station is open, whenever we know where the viewer is.
  const selectedDistance = useMemo(() => {
    if (selection.kind !== "station" || !index || geo.lat === undefined || geo.lon === undefined) return undefined;
    const st = index.station(selection.id);
    if (!st) return undefined;
    const cos = Math.cos((geo.lat * Math.PI) / 180);
    return Math.hypot((st.lon - geo.lon) * 111_320 * cos, (st.lat - geo.lat) * 111_320);
  }, [selection, index, geo.lat, geo.lon]);

  // Trains listed on the open station board get a ring on the map.
  const highlight = useMemo(() => {
    if (selection.kind !== "station") return new Set<string>();
    const target = selection.id;
    const ids = new Set<string>();
    for (const t of trains) {
      if (t.stops.some((s) => s.id.replace(/[NS]$/, "") === target) || t.nextStop.replace(/[NS]$/, "") === target) ids.add(t.id);
    }
    return ids;
  }, [selection, trains]);

  const mapReady = useDeferredMap();
  /*
   * The map's half: the geometry, fetched once the board is up. Two thirds of the network file is
   * polylines and the band layout derived from them, and none of it is needed to tell somebody
   * when their train is coming.
   */
  const [mapIndex, setMapIndex] = useState<NetworkIndex | null>(null);
  useEffect(() => {
    if (!mapReady || mapIndex) return;
    fetch(asset("/data/network.json"))
      .then((r) => r.json())
      .then((n: Network) => setMapIndex(new NetworkIndex(n)))
      .catch(() => {});
  }, [mapReady, mapIndex]);

  return (
    <main className="app">
      {mapIndex && <TrainMap
        index={mapIndex}
        statesRef={statesRef}
        positionsRef={positionsRef}
        clock={clock}
        speed={status.live ? 1 : status.speed}
        visibleRoutes={visible}
        showRibbons={showRibbons}
        selection={selection}
        onSelect={select}
        follow={follow}
        onFollowEnd={() => setFollow(false)}
        highlight={highlight}
        focusKey={focusKey}
        fitRoute={fitRoute}
        onView={setView}
        reducedMotion={reducedMotion}
      />}
      {index && (
        <Panel
          index={index} trains={trains} byId={byId} positionsRef={positionsRef} feeds={feeds}
          status={status} now={now} wallNow={wallNow} alerts={alerts}
          selection={selection} onSelect={select} follow={follow} onFollow={setFollow}
          visible={visible} onToggle={onToggle} onAll={onAll}
          showRibbons={showRibbons} onRibbons={setShowRibbons}
          mode={mode} onMode={setMode} mobile={mobile}
          nearby={nearby} onNearby={() => setNearby((n) => !n)}
          locating={geo.status === "asking"} distance={selectedDistance}
          destination={destination} onDestination={(id) => setDestination(id ?? undefined)}
          places={places} onToggleSave={togglePlace} isSaved={isSaved}
        />
      )}
      {!index && <div className="booting">loading the network…</div>}
    </main>
  );
}

export default function Home() {
  const [index, setIndex] = useState<NetworkIndex | null>(null);

  // The board's half of the network: names, routes and complexes, without a single polyline.
  useEffect(() => {
    fetch(asset("/data/network-lite.json"))
      .then((r) => r.json())
      .then((n: Network) => setIndex(new NetworkIndex(n)))
      .catch(() => {});
  }, []);

  return <App index={index} />;
}
