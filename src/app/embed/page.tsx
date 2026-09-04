"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { Network, Selection, TrainPosition } from "@/lib/types";
import { NetworkIndex } from "@/lib/network";
import { useTrainStream } from "@/lib/useTrainStream";
import { useReducedMotion, useTicker } from "@/lib/hooks";
import { arrivalsAt } from "@/lib/arrivals";
import { directionLabel, fmtMin } from "@/lib/format";
import { asset, BASE_PATH } from "@/lib/basePath";
import { RouteBullet } from "@/components/brand";

const TrainMap = dynamic(() => import("@/components/TrainMap"), { ssr: false });

interface Options { station?: string; route?: string; board: boolean }

function readOptions(): Options {
  if (typeof window === "undefined") return { board: true };
  const p = new URLSearchParams(window.location.search);
  return {
    station: p.get("station") ?? undefined,
    route: p.get("route") ?? undefined,
    board: p.get("board") !== "0",
  };
}

/**
 * A minimal, iframe-able view: one station's arrivals or one line, with no panel and no chrome.
 *   /embed/?station=A24        /embed/?route=L        /embed/?station=A24&board=0
 */
export default function Embed() {
  const [index, setIndex] = useState<NetworkIndex | null>(null);
  const [opts, setOpts] = useState<Options>({ board: true });
  const positionsRef = useRef(new Map<string, TrainPosition>());
  const { statesRef, trains, clock } = useTrainStream({ kind: "live" }, index);
  const reducedMotion = useReducedMotion();
  const now = useTicker(clock, 2);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reads window.location, unavailable during render
    setOpts(readOptions());
    fetch(asset("/data/network.json")).then((r) => r.json()).then((n: Network) => setIndex(new NetworkIndex(n))).catch(() => {});
  }, []);

  const selection: Selection = useMemo(
    () => (opts.station ? { kind: "station", id: opts.station } : { kind: "none" }),
    [opts.station],
  );
  const visible = useMemo(() => (opts.route ? new Set([opts.route]) : null), [opts.route]);
  const groups = useMemo(
    () => (index && opts.station && opts.board ? arrivalsAt(index, trains, opts.station, 3) : []),
    [index, opts.station, opts.board, trains],
  );
  const highlight = useMemo(() => new Set(groups.flatMap((g) => g.arrivals.map((a) => a.id))), [groups]);

  return (
    <main className="app">
      <TrainMap
        index={index} statesRef={statesRef} positionsRef={positionsRef} clock={clock} speed={1}
        visibleRoutes={visible} showRibbons selection={selection} onSelect={() => {}}
        follow={false} onFollowEnd={() => {}} highlight={highlight} focusKey={0}
        fitRoute={opts.route ?? null} reducedMotion={reducedMotion} minimal
      />
      {index && opts.station && opts.board && (
        <div className="embed-card">
          <h2>{index.stationName(opts.station)}</h2>
          {groups.length === 0 && <p className="muted hint">No trains approaching.</p>}
          {groups.map((g) => (
            <div className="embed-group" key={g.direction}>
              <h3>{directionLabel(g.direction)}</h3>
              {g.arrivals.map((a) => (
                <div className="embed-row" key={a.id}>
                  <RouteBullet index={index} route={a.route} size="md" />
                  <span className="embed-dest">{index.stationName(a.destination)}</span>
                  <span className="embed-eta">{a.atPlatform ? "here" : fmtMin(a.eta - now)}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
      <a className="embed-brand" href={`${BASE_PATH}/`} target="_blank" rel="noreferrer">bound</a>
    </main>
  );
}
