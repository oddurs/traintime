"use client";

import { useEffect, useMemo, useState } from "react";
import type { Selection, TrainPosition, TrainState } from "@/lib/types";
import type { NetworkIndex } from "@/lib/network";
import type { AlertIndex } from "@/lib/alerts";
import { etaProvenance, fmtIn, holdReason, kmh, provenance } from "@/lib/format";
import { Button, Callout, Card, IconButton, List, Meter, Notice, Row } from "./ui";
import RouteBullet from "./RouteBullet";
import AlertList from "./AlertList";
import { betterConnection } from "@/lib/connection";

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
  /** Where the rider said they are going, if they have. */
  destination?: string;
  onClose: () => void;
}

/** How often the readout re-samples the motion loop, which integrates every frame. */
const SAMPLE_MS = 250;
/** How many stops ahead are worth listing before it stops being a journey and becomes a table. */
const STOPS_SHOWN = 10;
/** Below this, "leaves in n seconds" is noise and the answer is "now". */
const LEAVING_S = 5;

/** One train: where it is, how we know, and what it will do next. */
export default function TrainDetail({ index, state, positionsRef, byId, now, alerts, following, onFollow, onSelect, onClose, destination }: Props) {
  const [position, setPosition] = useState<TrainPosition | undefined>(undefined);
  useEffect(() => {
    const read = () => setPosition(positionsRef.current.get(state.id));
    read();
    const id = setInterval(read, SAMPLE_MS);
    return () => clearInterval(id);
  }, [positionsRef, state.id]);

  const terminal = state.destination ?? state.stops[state.stops.length - 1]?.id;
  const dest = terminal && index.station(terminal) ? index.stationName(terminal) : null;
  const prov = provenance(index, state, now);
  const hold = position ? holdReason(index, position, byId) : null;
  const routeAlerts = useMemo(() => (alerts?.byRoute.get(state.route) ?? []).filter((a) => a.category === "delay"), [alerts, state.route]);
  const progress = position && position.length > 0 ? position.s / position.length : 0;

  /*
   * What you need when you are on the train rather than watching it: the next stop, what you can
   * change to there, and — the one thing only we can answer, because we hold every train's
   * predictions at once — whether you should get off and take a different one.
   */
  const nextName = state.nextStop ? index.stationName(state.nextStop) : null;
  const nextIn = state.phase === "moving" ? state.eta - now : null;
  const changes = useMemo(() => {
    if (!state.nextStop) return [];
    const key = index.complexKey(state.nextStop.replace(/[NS]$/, "")) ?? state.nextStop.replace(/[NS]$/, "");
    return (index.complexRoutes(key) ?? []).filter((r) => r !== state.route);
  }, [index, state.nextStop, state.route]);
  const swap = useMemo(
    () => (destination ? betterConnection(index, byId.values(), state, destination, now) : undefined),
    [index, byId, state, destination, now],
  );

  return (
    <section className="detail" aria-label={dest ? `${state.route} train to ${dest}` : `${state.route} train`}>
      <header className="detail-head">
        <RouteBullet index={index} route={state.route} size="xl" />
        <div className="detail-title">
          <h2>{dest ? `to ${dest}` : `${state.route} train`}</h2>
          <div className="sub">
            {state.trainId ?? state.id}
            {state.track ? ` · track ${state.track}` : ""}
            {state.assigned ? "" : " · unassigned"}
          </div>
        </div>
        <IconButton icon="xmark" onClick={onClose} ariaLabel="Close train" />
      </header>

      <Card>
        <Notice tone={prov.confident ? "ok" : "warn"}>{prov.line}</Notice>
      </Card>

      {nextName && (
        <Card>
          <div className="next-stop">
            <h3 className="sect-title">Next stop</h3>
            <div className="next-row">
              <b>{nextName}</b>
              {nextIn !== null && <span className="next-eta">{fmtIn(nextIn)}</span>}
            </div>
            {changes.length > 0 && (
              <div className="next-changes">
                <span>change for</span>
                {changes.slice(0, 8).map((r) => <RouteBullet key={r} index={index} route={r} size="md" />)}
              </div>
            )}
          </div>
        </Card>
      )}

      {swap && (
        <Callout lead="Faster" onClick={() => onSelect({ kind: "train", id: swap.toId })}>
          Change at <b>{swap.atName}</b> for the <RouteBullet index={index} route={swap.toRoute} size="sm" /> — about{" "}
          <b>{Math.round(swap.saving / 60)} min</b> sooner.
        </Callout>
      )}

      {state.phase === "moving" && position && (
        <div className="motion">
          <Meter value={progress} ariaLabel={`${Math.round(progress * 100)}% of the way to ${index.stationName(state.nextStop)}`} />
          <div className="motion-facts">
            <span>{kmh(position.speed)} km/h</span>
            <span>{hold ?? position.motion}</span>
            <span>{index.stationName(state.nextStop)} in {fmtIn(state.eta - now)}</span>
          </div>
        </div>
      )}
      {state.phase === "dwelling" && state.expectedDeparture !== undefined && (
        <div className="motion-facts one">
          <span>Leaves {state.expectedDeparture - now > LEAVING_S ? `in ${Math.round(state.expectedDeparture - now)} s` : "now"}</span>
        </div>
      )}

      {routeAlerts.length > 0 && <AlertList index={index} alerts={routeAlerts} limit={1} />}

      <List>
        {state.stops.slice(0, STOPS_SHOWN).map((s, i) => (
          <Row
            key={s.id + i}
            title={index.stationName(s.id)}
            subtitle={etaProvenance(s.eta, s.etaRaw, s.sigma)}
            trailing={fmtIn(s.eta - now)}
            onClick={() => onSelect({ kind: "station", id: s.id.replace(/[NS]$/, "") })}
          />
        ))}
      </List>

      <div className="detail-actions">
        <Button variant={following ? "filled" : "plain"} wide onClick={() => onFollow(!following)}>
          {following ? "following — tap to stop" : "follow this train"}
        </Button>
      </div>
    </section>
  );
}
