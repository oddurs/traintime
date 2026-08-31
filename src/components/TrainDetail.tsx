"use client";

import { useEffect, useMemo, useState } from "react";
import type { Selection, TrainPosition, TrainState } from "@/lib/types";
import type { NetworkIndex } from "@/lib/network";
import type { AlertIndex } from "@/lib/alerts";
import { etaProvenance, fmtIn, holdReason, kmh, provenance } from "@/lib/format";
import RouteBullet from "./RouteBullet";
import AlertList from "./AlertList";

interface Props {
  index: NetworkIndex;
  state: TrainState;
  positionsRef: React.RefObject<Map<string, TrainPosition>>;
  byId: Map<string, TrainState>;
  now: number;
  alerts: AlertIndex | null;
  following: boolean;
  onFollow: (on: boolean) => void;
  onSelect: (s: Selection) => void;
  onClose: () => void;
}

/** One train: where it is, how we know, and what it will do next. */
export default function TrainDetail({ index, state, positionsRef, byId, now, alerts, following, onFollow, onSelect, onClose }: Props) {
  // The map integrates motion every frame; sample it a few times a second for the readout.
  const [position, setPosition] = useState<TrainPosition | undefined>(undefined);
  useEffect(() => {
    const read = () => setPosition(positionsRef.current.get(state.id));
    read();
    const id = setInterval(read, 250);
    return () => clearInterval(id);
  }, [positionsRef, state.id]);

  const terminal = state.destination ?? state.stops[state.stops.length - 1]?.id;
  const dest = terminal && index.station(terminal) ? index.stationName(terminal) : null;
  const prov = provenance(index, state, now);
  const hold = position ? holdReason(index, position, byId) : null;
  const routeAlerts = useMemo(() => (alerts?.byRoute.get(state.route) ?? []).filter((a) => a.category === "delay"), [alerts, state.route]);
  const pct = position && position.length > 0 ? Math.round((100 * position.s) / position.length) : null;

  return (
    <section className="detail" aria-label={dest ? `${state.route} train to ${dest}` : `${state.route} train`}>
      <header className="detail-head">
        <RouteBullet index={index} route={state.route} size={30} />
        <div className="detail-title">
          <h2>{dest ? `to ${dest}` : `${state.route} train`}</h2>
          <div className="muted">
            {state.trainId ?? state.id}
            {state.track ? ` · track ${state.track}` : ""}
            {state.assigned ? "" : " · unassigned"}
          </div>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close train">×</button>
      </header>

      <div className={`provenance ${prov.confident ? "sure" : "modelled"}`}>
        <span className="prov-dot" aria-hidden="true" />
        {prov.line}
      </div>

      {state.phase === "moving" && position && (
        <div className="motion">
          <div className="motion-bar" role="img" aria-label={`${pct}% of the way to ${index.stationName(state.nextStop)}`}>
            <i style={{ width: `${pct ?? 0}%` }} />
          </div>
          <div className="motion-facts">
            <span>{kmh(position.speed)} km/h</span>
            <span>{hold ?? position.motion}</span>
            <span>{index.stationName(state.nextStop)} in {fmtIn(state.eta - now)}</span>
          </div>
        </div>
      )}
      {state.phase === "dwelling" && state.expectedDeparture !== undefined && (
        <div className="motion-facts one">
          <span>Leaves {state.expectedDeparture - now > 5 ? `in ${Math.round(state.expectedDeparture - now)} s` : "now"}</span>
        </div>
      )}

      {routeAlerts.length > 0 && <AlertList index={index} alerts={routeAlerts} limit={1} />}

      <ol className="stops">
        {state.stops.slice(0, 10).map((s, i) => (
          <li key={s.id + i}>
            <button onClick={() => onSelect({ kind: "station", id: s.id.replace(/[NS]$/, "") })}>
              <span className="stop-name">{index.stationName(s.id)}</span>
              <span className="stop-eta">
                {fmtIn(s.eta - now)}
                <em>{etaProvenance(s.eta, s.etaRaw, s.sigma)}</em>
              </span>
            </button>
          </li>
        ))}
      </ol>

      <div className="detail-actions">
        <button className={following ? "primary" : ""} onClick={() => onFollow(!following)}>
          {following ? "following — tap to stop" : "follow this train"}
        </button>
      </div>
    </section>
  );
}
