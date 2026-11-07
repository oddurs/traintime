"use client";

import { useMemo } from "react";
import type { Selection, TrainState } from "@/lib/types";
import type { NetworkIndex } from "@/lib/network";
import type { AlertIndex } from "@/lib/alerts";
import { arrivalsAt } from "@/lib/arrivals";
import { directionLabel, fmtClock } from "@/lib/format";
import { walkSeconds } from "@/lib/places";
import { IconButton, List, Row } from "./ui";
import { BulletGroup, Countdown, DirectionHeading, RouteBullet, StationName } from "./brand";
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
  /**
   * The first trains have not arrived. An empty board then means "not yet", and saying "no trains
   * approaching" — which a station opened from a saved place or a link says at once — is false.
   */
  waiting?: boolean;
  saved?: boolean;
  onToggleSave?: () => void;
  destination?: string;
  onDestination?: (id: string | null) => void;
  onSelect: (s: Selection) => void;
  onClose: () => void;
}

/** Close enough that a number would be a lie. */
const HERE_S = 30;
/** How often the board re-reads the motion loop's positions to see what has stopped moving. */

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
export default function StationBoard({ index, station, trains, now, alerts, distance, stale, waiting, saved, onToggleSave, destination, onDestination, onSelect, onClose }: Props) {
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


  /*
   * What a screen reader is told as the board changes.
   *
   * The entire content of this app is a number that changes every second, and it was announced
   * once when the board opened and never again. Announcing every tick would be unusable, so this
   * is the next train rounded to the minute: it changes about once a minute, which is the rate at
   * which the answer actually changes.
   */
  const spokenMinute = Math.round(now / 60);
  const spokenNext = useMemo(() => {
    const next = groups.flatMap((g) => g.arrivals).sort((a, b) => a.eta - b.eta)[0];
    if (!next) return waiting ? `Waiting for live trains at ${name}.` : `No trains approaching ${name}.`;
    const mins = Math.max(0, Math.round((next.eta - now) / 60));
    const dest = index.stationName(next.destination);
    const when = next.atPlatform ? "is at the platform" : mins <= 0 ? "is arriving now" : `in ${mins} minute${mins === 1 ? "" : "s"}`;
    return `Next at ${name}: ${next.route} to ${dest} ${when}.`;
  }, [groups, name, index, spokenMinute, waiting]);   // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section className="board" aria-label={`Arrivals at ${name}`}>
      <p className="sr-only" aria-live="polite" aria-atomic="true">{spokenNext}</p>
      <header className="board-head">
        <div>
          <StationName>{name}</StationName>
          {distance !== undefined && (
            <div className="board-sub">
              {distance < 1000 ? `${Math.round(distance)} m away` : `${(distance / 1000).toFixed(1)} km away`}
              {walk !== undefined && ` · about ${Math.max(1, Math.round(walk / 60))} min walk`}
            </div>
          )}
          {stale !== undefined && <div className="board-sub stale">last seen {Math.round(stale)} s ago · reconnecting</div>}
          <BulletGroup index={index} routes={routes} size="md" />
        </div>
        <div className="board-actions">
          {onToggleSave && (
            <IconButton
              icon={saved ? "star.fill" : "star"} on={saved} onClick={onToggleSave} ariaPressed={!!saved}
              ariaLabel={saved ? "Remove from saved stations" : "Save this station"}
              title={saved ? "Saved — tap to remove" : "Save this station"}
            />
          )}
          <IconButton icon="xmark" onClick={onClose} ariaLabel="Close station" />
        </div>
      </header>

      {/*
        * Order is the whole usability argument here. The countdown is what someone standing on a
        * platform came for, so it comes first; a service change is a one-line banner above it,
        * which keeps the warning in sight without costing the answer; and choosing a destination
        * is a second question, asked after the first has been answered.
        */}
      {stationAlerts.length > 0 && <AlertList index={index} alerts={stationAlerts} limit={2} collapsed />}

      {groups.length === 0 && waiting && <p className="muted" role="status">waiting for live trains…</p>}
      {groups.length === 0 && !waiting && (
        <p className="muted">
          {destination ? `No trains from here to ${index.stationName(destination)} right now.` : "No trains approaching right now."}
        </p>
      )}

      {groups.map((g) => {
        // At a terminal the trains pulling in are ending their runs; what a rider can act on is
        // the next one to leave. When every train listed starts its run here, the board says so.
        const leaving = g.arrivals.length > 0 && g.arrivals.every((a) => a.departing);
        return (
          <div className="board-group" key={g.direction}>
            <DirectionHeading direction={leaving ? "Departures" : directionLabel(g.direction)} toward={g.label} />
            <List leading>
              {g.arrivals.map((a) => {
                const secs = a.eta - now;
                const here = a.atPlatform || secs < HERE_S;
                const catchable = walk === undefined ? undefined : secs >= walk;
                // A countdown built on a train that has been held for minutes is not a countdown:
                // "three stops away" is true and useless, and saying so is the difference between
                // waiting and walking. The tracker decides it, so it is right from the first look.
                const held = a.state.status === "held" ? Math.max(1, Math.round((a.state.heldFor ?? 0) / 60)) : null;
                const context =
                  a.rideSeconds !== undefined
                    ? `arrives ${fmtClock(a.destEta!)} · ${Math.round(a.rideSeconds / 60)} min ride`
                    : a.departing && a.atPlatform ? "at the platform, ready to leave"
                    : a.atPlatform ? "at the platform"
                    : catchable === false ? "too soon to reach on foot"
                    : held !== null ? `held ${held} min · ${a.stopsAway === 0 ? "next stop" : `${a.stopsAway} stops away`}`
                    : `${a.stopsAway === 0 ? "next stop" : `${a.stopsAway} stop${a.stopsAway > 1 ? "s" : ""} away`}${a.sigma ? ` · give or take ${Math.round(a.sigma)} s` : ""}`;
                return (
                  <Row
                    key={a.id}
                    leading={<RouteBullet index={index} route={a.route} size="lg" />}
                    title={index.stationName(a.destination)}
                    subtitle={context}
                    trailing={<Countdown seconds={secs} here={here} departing={a.departing} missed={catchable === false} />}
                    onClick={() => onSelect({ kind: "train", id: a.id })}
                    title_="Show this train on the map"
                    ariaLabel={spoken(index, a.route, a.destination, secs, a.atPlatform, a.sigma)}
                  />
                );
              })}
            </List>
          </div>
        );
      })}
      {onDestination && <DestinationPicker index={index} destination={destination} onChange={onDestination} />}
    </section>
  );
}
