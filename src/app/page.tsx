"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Panel from "@/components/Panel";
import type { Network, Selection, TrainPosition } from "@/lib/types";
import { NetworkIndex } from "@/lib/network";
import { useTrainStream, type StreamMode } from "@/lib/useTrainStream";
import { useIsMobile, useReducedMotion, useTicker } from "@/lib/hooks";
import { fetchAlerts, type AlertIndex } from "@/lib/alerts";
import { readHash, writeHash } from "@/lib/urlState";
import { asset } from "@/lib/basePath";
import type { View } from "@/components/TrainMap";

const TrainMap = dynamic(() => import("@/components/TrainMap"), { ssr: false });

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
    setHydrated(true);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, []);

  const { statesRef, trains, feeds, status, clock } = useTrainStream(mode, index);
  const mobile = useIsMobile();
  const reducedMotion = useReducedMotion();
  const now = useTicker(clock, 2);
  const wallNow = useTicker(() => Date.now() / 1000, 1);

  const byId = useMemo(() => new Map(trains.map((t) => [t.id, t])), [trains]);

  // Service alerts, refreshed slowly — they change on the order of minutes.
  useEffect(() => {
    const ctl = new AbortController();
    const load = () => fetchAlerts(ctl.signal).then(setAlerts).catch(() => {});
    load();
    const id = setInterval(load, ALERTS_EVERY);
    return () => { ctl.abort(); clearInterval(id); };
  }, []);

  // Every view is a link.
  useEffect(() => {
    if (!hydrated) return;
    writeHash({
      station: selection.kind === "station" ? selection.id : undefined,
      train: selection.kind === "train" ? selection.id : undefined,
      routes: visible ? [...visible] : undefined,
      view,
      replay: mode.kind === "replay" ? mode : undefined,
    });
  }, [hydrated, selection, visible, view, mode]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (follow) setFollow(false);
      else setSelection({ kind: "none" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [follow]);

  const select = useCallback((s: Selection) => {
    setSelection(s);
    setFollow(false);
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

  return (
    <main className="app">
      <TrainMap
        index={index}
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
      />
      {index && (
        <Panel
          index={index} trains={trains} byId={byId} positionsRef={positionsRef} feeds={feeds}
          status={status} now={now} wallNow={wallNow} alerts={alerts}
          selection={selection} onSelect={select} follow={follow} onFollow={setFollow}
          visible={visible} onToggle={onToggle} onAll={onAll}
          showRibbons={showRibbons} onRibbons={setShowRibbons}
          mode={mode} onMode={setMode} mobile={mobile}
        />
      )}
      {!index && <div className="booting">loading the network…</div>}
    </main>
  );
}

export default function Home() {
  const [index, setIndex] = useState<NetworkIndex | null>(null);

  useEffect(() => {
    fetch(asset("/data/network.json"))
      .then((r) => r.json())
      .then((n: Network) => setIndex(new NetworkIndex(n)))
      .catch(() => {});
  }, []);

  return <App index={index} />;
}
