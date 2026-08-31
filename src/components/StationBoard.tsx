"use client";

import { useMemo } from "react";
import type { Selection, TrainState } from "@/lib/types";
import type { NetworkIndex } from "@/lib/network";
import type { AlertIndex } from "@/lib/alerts";
import { arrivalsAt } from "@/lib/arrivals";
import { directionLabel, fmtMin, etaProvenance } from "@/lib/format";
import RouteBullet from "./RouteBullet";
import AlertList from "./AlertList";

interface Props {
  index: NetworkIndex;
  station: string;
  trains: TrainState[];
  now: number;
  alerts: AlertIndex | null;
  onSelect: (s: Selection) => void;
  onClose: () => void;
}

/**
 * The arrivals board for one station, computed from the same train states the map draws —
 * so what it says and what you see can never disagree.
 */
export default function StationBoard({ index, station, trains, now, alerts, onSelect, onClose }: Props) {
  const groups = useMemo(() => arrivalsAt(index, trains, station), [index, trains, station]);
  const st = index.station(station);
  const routes = useMemo(() => index.net.stationRoutes[station] ?? [], [index, station]);
  const stationAlerts = useMemo(() => {
    if (!alerts) return [];
    const seen = new Set<string>();
    const out = [...(alerts.byStation.get(station) ?? [])];
    for (const a of out) seen.add(a.id);
    for (const r of routes) for (const a of alerts.byRoute.get(r) ?? []) {
      if (!seen.has(a.id) && a.category === "delay") { seen.add(a.id); out.push(a); }
    }
    return out;
  }, [alerts, station, routes]);

  return (
    <section className="board" aria-label={`Arrivals at ${st?.name ?? station}`}>
      <header className="board-head">
        <div>
          <h2>{st?.name ?? station}</h2>
          <div className="board-routes">
            {routes.map((r) => <RouteBullet key={r} index={index} route={r} size={18} />)}
          </div>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close station">×</button>
      </header>

      {stationAlerts.length > 0 && <AlertList index={index} alerts={stationAlerts} limit={2} />}

      {groups.length === 0 && <p className="muted">No trains approaching right now.</p>}

      {groups.map((g) => (
        <div className="board-group" key={g.direction}>
          <h3>
            {directionLabel(g.direction)} <span className="muted">· toward {g.label}</span>
          </h3>
          <ul className="arrivals">
            {g.arrivals.map((a) => {
              const secs = a.eta - now;
              return (
                <li key={a.id}>
                  <button onClick={() => onSelect({ kind: "train", id: a.id })} title="Show this train on the map">
                    <RouteBullet index={index} route={a.route} size={22} />
                    <span className="arr-dest">
                      {index.stationName(a.destination)}
                      <em>
                        {a.atPlatform
                          ? "at the platform now"
                          : `${a.stopsAway === 0 ? "next stop" : `${a.stopsAway} stop${a.stopsAway > 1 ? "s" : ""} away`} · ${etaProvenance(a.eta, a.etaRaw, a.sigma)}`}
                      </em>
                    </span>
                    <span className={`arr-eta ${a.atPlatform || secs < 30 ? "here" : ""}`}>
                      {a.atPlatform ? "here" : fmtMin(secs)}
                      {!a.atPlatform && secs >= 30 && <i>min</i>}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </section>
  );
}
