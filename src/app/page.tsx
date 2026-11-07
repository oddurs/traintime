"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { loadTrainMap } from "@/components/loadTrainMap";
import Panel from "@/components/Panel";
import type { Network, Selection, TrainPosition } from "@/lib/types";
import { NetworkIndex } from "@/lib/network";
import { useTrainStream, type StreamMode } from "@/lib/useTrainStream";
import { useReducedMotion, useTicker } from "@/lib/hooks";
import { fetchAlerts, type AlertIndex } from "@/lib/alerts";
import { useGeolocation, useWakeLock } from "@/lib/geolocation";
import { nearbyStations, radiusMetres, type RadiusMin } from "@/lib/nearby";
import { usePlaces } from "@/lib/places";
import { useRecents } from "@/lib/recents";
import { closePlace, openPlace, readHash, writeHash } from "@/lib/urlState";
import { asset } from "@/lib/basePath";
import { posterTransform } from "@/lib/home";
import { Button, Notice } from "@/components/ui";
import type { View } from "@/components/TrainMap";

/*
 * The map engine, as a load that can be started before it is rendered. The map needs two downloads,
 * the engine and the network's geometry, and it used to ask for them one after the other: the
 * geometry, then — once it had arrived and been parsed and React had rendered — the engine. On a
 * slow link that was 105 KB, a stretch of CPU with the link idle, and then 260 KB. Asked for
 * together, they share the link and the parse happens while the engine is still arriving.
 */
const TrainMap = dynamic(loadTrainMap, { ssr: false });

/**
 * Hold the map back until the panel has painted.
 *
 * The map engine is 936 KB — three quarters of everything the app downloads — and although it is
 * already code-split, rendering it on the first pass puts its request in the same queue as the
 * ones the panel needs. Measured cold on a slow connection, nothing a rider could read appeared
 * for 32 seconds. Waiting costs nothing anyone can perceive and lets the board come first, which
 * is the thing somebody standing on a platform actually opened the app for.
 *
 * The wait starts when the board's own half of the network has landed, not when this component
 * mounts. Timed from mount, the idle deadline was counting down through the very work it was
 * meant to stay out of the way of, and the map's geometry went on the wire about a second after
 * the board could have spared the bandwidth. Idle is the right signal; it was just being asked
 * too early.
 */
function useDeferredMap(ready: boolean): boolean {
  const [go, setGo] = useState(false);
  useEffect(() => {
    if (!ready) return;
    const w = window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
    if (w.requestIdleCallback) { const h = w.requestIdleCallback(() => setGo(true), { timeout: 1500 }); return () => cancelIdleCallback(h); }
    const h = setTimeout(() => setGo(true), 120);
    return () => clearTimeout(h);
  }, [ready]);
  return go;
}

const ALERTS_EVERY = 120_000;
/**
 * How long alerts will wait for the map before loading anyway — long enough for a slow link to
 * finish the map, and still bounded, because a list of planned closures should not wait on a map
 * that is never going to load. At 12 s the deadline fell inside the map engine's own download on
 * slow 4G and the alerts took a third of the link from it.
 */
const ALERTS_LATEST = 30_000;

/**
 * A fetch of one of the network's two halves, that can fail visibly and be tried again.
 *
 * Both used to end in `.catch(() => {})`: a dropped connection on the way in left "loading the
 * network…" on screen for good, or a map that simply never arrived, with nothing to press. Coming
 * back online retries by itself, because on a train that is how the connection comes back.
 */
function useNetworkFile(path: string, enabled: boolean) {
  const [index, setIndex] = useState<NetworkIndex | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => { setFailed(false); setAttempt((a) => a + 1); }, []);
  useEffect(() => {
    if (!enabled || index) return;
    const ctl = new AbortController();
    fetch(asset(path), { signal: ctl.signal })
      .then((r) => { if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`); return r.json(); })
      .then((n: Network) => setIndex(new NetworkIndex(n)))
      .catch((e: unknown) => { if (!ctl.signal.aborted) { console.error(e); setFailed(true); } });
    return () => ctl.abort();
  }, [path, enabled, index, attempt]);
  useEffect(() => {
    if (!failed) return;
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  }, [failed, retry]);
  return { index, failed, retry };
}

function App({ index, failed }: { index: NetworkIndex | null; failed?: () => void }) {
  const [mode, setMode] = useState<StreamMode>({ kind: "live" });
  const [visible, setVisible] = useState<Set<string> | null>(null);
  const [showRibbons, setShowRibbons] = useState(true);
  const [selection, setSelection] = useState<Selection>({ kind: "none" });
  const [follow, setFollow] = useState(false);
  const [focusKey, setFocusKey] = useState(0);
  const [fitRoute, setFitRoute] = useState<string | null>(null);
  const [alerts, setAlerts] = useState<AlertIndex | null>(null);
  const [mapDrawn, setMapDrawn] = useState(false);
  const [mapShown, setMapShown] = useState(false);
  const [posterGone, setPosterGone] = useState(false);
  const [view, setView] = useState<View | undefined>(undefined);
  const [hydrated, setHydrated] = useState(false);
  const [nearby, setNearby] = useState(false);
  const [radius, setRadius] = useState<RadiusMin>(10);
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
  const reducedMotion = useReducedMotion();
  const now = useTicker(clock, 2);
  const wallNow = useTicker(() => Date.now() / 1000, 1);

  const byId = useMemo(() => new Map(trains.map((t) => [t.id, t])), [trains]);

  const mapReady = useDeferredMap(index !== null);
  /*
   * The map's half: the geometry, fetched once the board is up. Two thirds of the network file is
   * polylines and the band layout derived from them, and none of it is needed to tell somebody
   * when their train is coming.
   */
  const { index: mapIndex, failed: mapFailed, retry: retryMap } = useNetworkFile("/data/network.json", mapReady);
  const [engineFailed, setEngineFailed] = useState(false);
  useEffect(() => {
    if (!mapReady) return;
    loadTrainMap().catch((e: unknown) => { console.error(e); setEngineFailed(true); });
  }, [mapReady]);

  /*
   * Service alerts, refreshed slowly — they change on the order of minutes.
   *
   * Held back until everything a rider came for has arrived. The alert feed is 83 KB, which is a
   * quarter of what the whole app downloads, and on a slow connection the link is the constraint:
   * whatever is on it is delaying whatever is behind it. It used to load with the board and put
   * the countdown 13.6 seconds away; loaded with the map it did the same to the geometry, holding
   * the map off the screen for the length of its own download.
   *
   * So it goes last, after the map is on screen — not merely after its geometry has arrived, which
   * left the engine's own 260 KB still on the wire beside it — with a deadline, because a list of
   * planned closures should not be hostage to a map that failed to load at all.
   */
  useEffect(() => {
    if (!index) return;
    const ctl = new AbortController();
    let id: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      if (ctl.signal.aborted || id !== undefined) return;
      const load = () => fetchAlerts(ctl.signal).then(setAlerts).catch(() => {});
      load();
      id = setInterval(load, ALERTS_EVERY);
    };
    if (mapDrawn) start();
    const late = setTimeout(start, ALERTS_LATEST);
    return () => { ctl.abort(); clearTimeout(late); if (id !== undefined) clearInterval(id); };
  }, [index, mapDrawn]);

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

  /*
   * Back, from anywhere: the browser's button, the phone's edge swipe, Android's back key. Each
   * opened place is a history entry (openPlace), so going back hands us the entry before it, and
   * the app becomes whatever that entry says.
   */
  useEffect(() => {
    const onPop = () => {
      const h = readHash();
      setSelection(h.station ? { kind: "station", id: h.station } : h.train ? { kind: "train", id: h.train } : { kind: "none" });
      setDestination(h.to);
      setFollow(false);
      setFocusKey((k) => k + 1);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  /*
   * What is arriving within a walk of the viewer, while they have asked to be located. It used to
   * open the single nearest station and follow from one to the next, which answered "where is the
   * closest platform" rather than "which trains can I catch".
   */
  const hereLat = nearby ? geo.lat : undefined;
  const hereLon = nearby ? geo.lon : undefined;
  const nearbyList = useMemo(
    () => (hereLat !== undefined && hereLon !== undefined && index ? nearbyStations(index, trains, hereLat, hereLon, radiusMetres(radius)) : null),
    [index, trains, hereLat, hereLon, radius],
  );
  const nearbyArea = useMemo(
    () => (hereLat !== undefined && hereLon !== undefined ? { lat: hereLat, lon: hereLon, radius: radiusMetres(radius) } : null),
    [hereLat, hereLon, radius],
  );

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

  // Remember which station was looked at: the saved list leads with it next time, and search
  // offers it before anything is typed.
  const { recents, add: addRecent, clear: clearRecents } = useRecents();
  useEffect(() => {
    if (selection.kind !== "station") return;
    touchPlace(selection.id);
    if (index) addRecent(selection.id, index.complexName(selection.id));
  }, [selection, touchPlace, index, addRecent]);

  // The selection as of the last render, for deciding whether a choice is a new place to go.
  const selectionRef = useRef(selection);
  useEffect(() => { selectionRef.current = selection; }, [selection]);

  const select = useCallback((s: Selection) => {
    const cur = selectionRef.current;
    const same = s.kind === cur.kind && (s.kind === "none" || (cur.kind !== "none" && s.id === cur.id));
    // Closing goes back to the entry it was opened from; the popstate handler does the rest.
    if (s.kind === "none" && !same && closePlace()) return;
    if (s.kind !== "none" && !same) openPlace(s.kind === "station" ? { station: s.id } : { train: s.id });
    // Changing where you are starting from ends the old journey: keeping the destination gives
    // an empty board that reads like broken data rather than a finished trip.
    if (s.kind === "station" && !same) setDestination(undefined);
    setSelection(s);
    setFollow(false);
    setFocusKey((k) => k + 1);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (follow) setFollow(false);
      else select({ kind: "none" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [follow, select]);

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

  // Trains listed on the open station board get a ring on the map; with nothing open, the trains
  // in the nearby list do, so the list and the map point at the same trains.
  const highlight = useMemo(() => {
    const ids = new Set<string>();
    if (selection.kind === "none" && nearbyList) {
      for (const s of nearbyList) for (const a of s.arrivals) ids.add(a.id);
      return ids;
    }
    if (selection.kind !== "station") return ids;
    const target = selection.id;
    for (const t of trains) {
      if (t.stops.some((s) => s.id.replace(/[NS]$/, "") === target) || t.nextStop.replace(/[NS]$/, "") === target) ids.add(t.id);
    }
    return ids;
  }, [selection, trains, nearbyList]);

  // Where the poster stands in for the map, which is home unless a shared link says otherwise.
  const poster = hydrated ? posterTransform(view) : "";

  return (
    <main className="app">
      {poster !== null && !posterGone && (
        // eslint-disable-next-line @next/next/no-img-element -- a static SVG in the first paint; next/image would hold it back for hydration
        <img
          className={`poster${mapShown ? " is-gone" : ""}`}
          src={asset("/data/poster.svg")}
          // Low: it is a stand-in, and on a slow link it was taking bandwidth from the stylesheet the
          // first paint is blocked on.
          alt="" aria-hidden="true" decoding="async" fetchPriority="low"
          style={poster ? { transform: `translate(-50%, -50%) ${poster}` } : undefined}
          onTransitionEnd={() => mapShown && setPosterGone(true)}
        />
      )}
      {mapIndex && !engineFailed && <TrainMap
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
        onReady={() => setMapDrawn(true)}
        onShown={() => setMapShown(true)}
        nearby={nearbyArea}
      />}
      {(mapFailed || engineFailed) && (
        <div className="map-notice">
          {/* The engine is a module import, and a failed import stays failed for the page's life. */}
          <Notice tone="bad" action={<Button variant="ghost" onClick={() => (engineFailed ? location.reload() : retryMap())}>Try again</Button>}>
            The map couldn’t load.
          </Notice>
        </div>
      )}
      <Panel
          index={index} failed={failed} trains={trains} byId={byId} positionsRef={positionsRef} feeds={feeds}
          status={status} now={now} wallNow={wallNow} alerts={alerts}
          selection={selection} onSelect={select} follow={follow} onFollow={setFollow}
          visible={visible} onToggle={onToggle} onAll={onAll}
          showRibbons={showRibbons} onRibbons={setShowRibbons}
          mode={mode} onMode={setMode}
          nearby={{
            on: nearby, geo: geo.status, stations: nearbyList, radius, onRadius: setRadius,
            onLocate: () => setNearby((n) => !n),
          }}
          distance={selectedDistance}
          destination={destination} onDestination={(id) => setDestination(id ?? undefined)}
          places={places} placesLoaded={placesLoaded} onToggleSave={togglePlace} isSaved={isSaved}
          recents={recents} onClearRecents={clearRecents}
      />
    </main>
  );
}

export default function Home() {
  // The board's half of the network: names, routes and complexes, without a single polyline.
  const { index, failed, retry } = useNetworkFile("/data/network-lite.json", true);
  return <App index={index} failed={failed ? retry : undefined} />;
}
