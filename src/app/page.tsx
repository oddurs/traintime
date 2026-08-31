"use client";

import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import Panel from "@/components/Panel";
import type { Network } from "@/lib/types";
import { NetworkIndex } from "@/lib/network";
import { useTrainStream, type StreamMode } from "@/lib/useTrainStream";
import { asset } from "@/lib/basePath";

const TrainMap = dynamic(() => import("@/components/TrainMap"), { ssr: false });

function App({ index }: { index: NetworkIndex }) {
  const [mode, setMode] = useState<StreamMode>({ kind: "live" });
  const [visible, setVisible] = useState<Set<string>>(() => new Set(Object.keys(index.net.routes)));
  const [showRibbons, setShowRibbons] = useState(true);
  const { statesRef, trains, feeds, status, clock } = useTrainStream(mode, index);

  const onToggle = useCallback((route: string, solo: boolean) => {
    setVisible((v) => {
      if (solo) return new Set([route]);
      const next = new Set(v);
      if (next.has(route)) next.delete(route);
      else next.add(route);
      return next;
    });
  }, []);
  const onAll = useCallback((on: boolean) => setVisible(on ? new Set(Object.keys(index.net.routes)) : new Set()), [index]);

  return (
    <main className="app">
      <TrainMap
        index={index}
        statesRef={statesRef}
        clock={clock}
        speed={status.live ? 1 : status.speed}
        visibleRoutes={visible}
        showRibbons={showRibbons}
      />
      <Panel
        index={index}
        trains={trains}
        feeds={feeds}
        status={status}
        mode={mode}
        onMode={setMode}
        visible={visible}
        onToggle={onToggle}
        onAll={onAll}
        showRibbons={showRibbons}
        onRibbons={setShowRibbons}
        clock={clock}
      />
    </main>
  );
}

export default function Home() {
  const [index, setIndex] = useState<NetworkIndex | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(asset("/data/network.json"))
      .then((r) => r.json())
      .then((n: Network) => setIndex(new NetworkIndex(n)))
      .catch((e) => setError(`network.json: ${e.message}`));
  }, []);

  if (!index) return <div className="loading">{error ?? "loading network…"}</div>;
  return <App index={index} />;
}
