"use client";

import { useMemo } from "react";
import type { Selection, TrainState } from "@/lib/types";
import type { NetworkIndex } from "@/lib/network";
import type { AlertIndex } from "@/lib/alerts";
import { arrivalsAt } from "@/lib/arrivals";
import { directionLabel, fmtClock, fmtMin } from "@/lib/format";
import { walkSeconds } from "@/lib/places";
import RouteBullet from "./RouteBullet";
import AlertList from "./AlertList";
import DestinationPicker from "./DestinationPicker";

interface Props {
  index: NetworkIndex;
  station: string;
  trains: TrainState[];
  now: number;
  alerts: AlertIndex | null;
  /** Metres from the viewer, when their location is known. */
  distance?: number;
  stale?: number;
  saved?: boolean;
  onToggleSave?: () => void;
  destination?: string;
  onDestination?: (id: string | null) => void;
  onSelect: (s: Selection) => void;
  onClose: () => void;
}

/** How a person would say it out loud, for a screen reader. */
function spoken(index: NetworkIndex, route: string, dest: string, secs: number, atPlatform: boolean, sigma: number): string {
  const when = atPlatform
    ? "at the platform now"
    : secs < 45
      ? "arriving now"
      : `in ${Math.round(secs / 60)} minute${Math.round(secs / 60) === 1 ? "" : "s"}${sigma ? `, give or take ${Math.round(sigma)} seconds` : ""}`;
  return `${route} train to ${index.stationName(dest)}, ${when}`;
}

/**
 * The arrivals board for one station, computed from the same train states the map draws —
 * so what it says and what you see can never disagree.
 */
export default function StationBoard({ index, station, trains, now, alerts, distance, stale, saved, onToggleSave, destination, onDestination, onSelect, onClose }: Props) {
  const groups = useMemo(() => arrivalsAt(index, trains, station, 6, destination), [index, trains, station, destination]);
  // With a location we can say which trains are actually catchable on foot, which is the
  // difference between a timetable and advice.
  const walk = distance === undefined ? undefined : walkSeconds(distance);
  const name = index.complexName(station);
  const routes = useMemo(() => index.complexRoutes(station), [index, station]);
  const stationAlerts = useMemo(() => {
    if (!alerts) return [];
    const seen = new Set<string>();
    const out = index.complexStations(station).flatMap((id) => alerts.byStation.get(id) ?? []);
    for (const a of out) seen.add(a.id);
    for (const r of routes) for (const a of alerts.byRoute.get(r) ?? []) {
      if (!seen.has(a.id) && a.category === "delay") { seen.add(a.id); out.push(a); }
    }
    return out;
  }, [alerts, station, routes, index]);

  return (
    <section className="board" aria-label={`Arrivals at ${name}`}>
      <header className="board-head">
        <div>
          <h2>{name}</h2>
          {distance !== undefined && (
            <div className="board-distance">
              {distance < 1000 ? `${Math.round(distance)} m away` : `${(distance / 1000).toFixed(1)} km away`}
              {walk !== undefined && ` · about ${Math.max(1, Math.round(walk / 60))} min walk`}
            </div>
          )}
          {stale !== undefined && <div className="board-stale">last seen {Math.round(stale)} s ago · reconnecting</div>}
          <div className="board-routes">
            {routes.map((r) => <RouteBullet key={r} index={index} route={r} size={18} />)}
          </div>
        </div>
        <div className="board-actions">
          {onToggleSave && (
            <button
              className={`icon-btn ${saved ? "on" : ""}`}
              onClick={onToggleSave}
              aria-pressed={!!saved}
              aria-label={saved ? "Remove from saved stations" : "Save this station"}
              title={saved ? "Saved — tap to remove" : "Save this station"}
            >
              {saved ? "★" : "☆"}
            </button>
          )}
          <button className="icon-btn" onClick={onClose} aria-label="Close station">×</button>
        </div>
      </header>

      {/*
        * Order is the whole usability argument here. The countdown is what someone standing on a
        * platform came for, so it comes first; a service change is a one-line banner above it,
        * which keeps the warning in sight without costing the answer; and choosing a destination
        * is a second question, asked after the first has been answered.
        */}
      {stationAlerts.length > 0 && <AlertList index={index} alerts={stationAlerts} limit={2} collapsed />}

      {groups.length === 0 && (
        <p className="muted">
          {destination ? `No trains from here to ${index.stationName(destination)} right now.` : "No trains approaching right now."}
        </p>
      )}

      {groups.map((g) => (
        <div className="board-group" key={g.direction}>
          <h3>{directionLabel(g.direction)}</h3>
          <span className="board-toward">toward {g.label}</span>
          <ul className="arrivals">
            {g.arrivals.map((a) => {
              const secs = a.eta - now;
              const here = a.atPlatform || secs < 30;
              const catchable = walk === undefined ? undefined : secs >= walk;
              return (
                <li key={a.id}>
                  <button
                    onClick={() => onSelect({ kind: "train", id: a.id })}
                    title="Show this train on the map"
                    aria-label={spoken(index, a.route, a.destination, secs, a.atPlatform, a.sigma)}
                  >
                    <RouteBullet index={index} route={a.route} size={26} />
                    <span className="arr-dest">
                      <b>{index.stationName(a.destination)}</b>
                      <em>
                        {a.rideSeconds !== undefined
                          ? `arrives ${fmtClock(a.destEta!)} · ${Math.round(a.rideSeconds / 60)} min ride`
                          : a.atPlatform
                          ? "at the platform"
                          : catchable === false
                            ? "too soon to reach on foot"
                            : `${a.stopsAway === 0 ? "next stop" : `${a.stopsAway} stop${a.stopsAway > 1 ? "s" : ""} away`}${a.sigma ? ` · give or take ${Math.round(a.sigma)} s` : ""}`}
                      </em>
                    </span>
                    <span className={`arr-eta ${here ? "here" : ""} ${catchable === false ? "missed" : ""}`}>
                      <b>{here ? "now" : fmtMin(secs)}</b>
                      {!here && <i>min</i>}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      {onDestination && <DestinationPicker index={index} destination={destination} onChange={onDestination} />}
    </section>
  );
}
