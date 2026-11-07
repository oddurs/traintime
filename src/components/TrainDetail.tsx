"use client";

import { useEffect, useMemo, useState } from "react";
import type { Selection, TrainPosition, TrainState } from "@/lib/types";
import type { NetworkIndex } from "@/lib/network";
import type { AlertIndex } from "@/lib/alerts";
import { etaProvenance, fmtClock, fmtSpread, fmtWhen, kmh, provenance, statusLine } from "@/lib/format";
import { Button, Callout, Card, Disclosure, IconButton, Inline, List, Meter, Notice, Row, Stack, Text } from "./ui";
import { BulletGroup, Countdown, RouteBullet } from "./brand";
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
/** Close enough that a number would be a lie. */
const HERE_S = 30;

/**
 * One train, in the order a rider asks about it: where is it going, where is it now, when does it
 * get to my stop. How we know — the trip id, the track, whether a departure was reported or
 * modelled, how our estimate differs from the MTA's — is all still here, at the end and closed.
 * It used to be the first thing on the card: a trip id in monospace under the title and a
 * sentence about departure modelling above the next stop.
 */
export default function TrainDetail({ index, state, positionsRef, byId, now, alerts, following, onFollow, onSelect, onClose, destination }: Props) {
  const [position, setPosition] = useState<TrainPosition | undefined>(undefined);
  const [howOpen, setHowOpen] = useState(false);
  useEffect(() => {
    const read = () => setPosition(positionsRef.current.get(state.id));
    read();
    const id = setInterval(read, SAMPLE_MS);
    return () => clearInterval(id);
  }, [positionsRef, state.id]);

  const terminal = state.destination ?? state.stops[state.stops.length - 1]?.id;
  const dest = terminal && index.station(terminal) ? index.stationName(terminal) : null;
  const prov = provenance(index, state, now);
  const hold = statusLine(index, state, byId, now);
  const routeAlerts = useMemo(() => (alerts?.byRoute.get(state.route) ?? []).filter((a) => a.category === "delay"), [alerts, state.route]);
  const progress = position && position.length > 0 ? position.s / position.length : 0;

  const nextName = state.nextStop ? index.stationName(state.nextStop) : null;
  const nextIn = state.eta - now;
  const changes = useMemo(() => {
    if (!state.nextStop) return [];
    const key = index.complexKey(state.nextStop.replace(/[NS]$/, ""));
    return index.complexRoutes(key).filter((r) => r !== state.route);
  }, [index, state.nextStop, state.route]);
  const swap = useMemo(
    () => (destination ? betterConnection(index, byId.values(), state, destination, now) : undefined),
    [index, byId, state, destination, now],
  );

  // Where it is, in one line: what a rider glances at before anything else.
  const where = hold
    ?? (state.phase === "dwelling" && nextName
      ? `At ${nextName}${state.expectedDeparture !== undefined ? ` · leaves ${fmtWhen(state.expectedDeparture - now) === "now" ? "now" : `in ${fmtWhen(state.expectedDeparture - now)}`}` : ""}`
      : nextName ? `Next: ${nextName} · ${fmtWhen(nextIn) === "now" ? "arriving" : `in ${fmtWhen(nextIn)}`}` : null);
  const next = state.stops[0];

  return (
    <section className="detail" aria-label={dest ? `${state.route} train to ${dest}` : `${state.route} train`}>
      <header className="detail-head">
        <RouteBullet index={index} route={state.route} size="xl" />
        <div className="detail-title">
          <h2>{dest ? `to ${dest}` : `${state.route} train`}</h2>
          {where && <Text variant="subhead" tone="secondary" truncate>{where}</Text>}
        </div>
        <IconButton icon="xmark" onClick={onClose} ariaLabel="Close train" />
      </header>

      <Button variant={following ? "filled" : "tinted"} icon={following ? "location.fill" : "location"} wide onClick={() => onFollow(!following)} ariaPressed={following}>
        {following ? "Following — tap to stop" : "Follow this train"}
      </Button>

      {swap && (
        <Callout lead="Faster" onClick={() => onSelect({ kind: "train", id: swap.toId })}>
          Change at <b>{swap.atName}</b> for the <RouteBullet index={index} route={swap.toRoute} size="sm" /> — about{" "}
          <b>{Math.round(swap.saving / 60)} min</b> sooner.
        </Callout>
      )}

      {nextName && state.phase !== "dwelling" && (
        <Card>
          <Stack gap={2}>
            <Inline justify="between" align="baseline" gap={3}>
              <Stack gap={0}>
                <Text variant="micro" tone="tertiary" caps>Next stop</Text>
                <Text variant="title" truncate>{nextName}</Text>
              </Stack>
              <Countdown seconds={nextIn} here={nextIn < HERE_S} compact />
            </Inline>
            {changes.length > 0 && <BulletGroup index={index} routes={changes} size="md" limit={8} lead="change for" />}
            {state.phase === "moving" && position && (
              <Stack gap={1}>
                <Meter value={progress} ariaLabel={`${Math.round(progress * 100)}% of the way to ${nextName}`} />
                <Text variant="footnote" tone="tertiary" numeric>{kmh(position.speed)} km/h · {position.motion}</Text>
              </Stack>
            )}
          </Stack>
        </Card>
      )}

      {routeAlerts.length > 0 && <AlertList index={index} alerts={routeAlerts} limit={1} />}

      <List ariaLabel="Stops ahead">
        {state.stops.slice(0, STOPS_SHOWN).map((s, i) => {
          const spread = fmtSpread(s.sigma);
          return (
            <Row
              key={s.id + i}
              title={index.stationName(s.id)}
              subtitle={`arrives ${fmtClock(s.eta)}${spread ? ` · ${spread}` : ""}`}
              trailing={fmtWhen(s.eta - now)}
              onClick={() => onSelect({ kind: "station", id: s.id.replace(/[NS]$/, "") })}
              ariaLabel={`${index.stationName(s.id)}, ${fmtWhen(s.eta - now) === "now" ? "arriving now" : `in ${fmtWhen(s.eta - now)}`}`}
            />
          );
        })}
      </List>

      <Disclosure lead="How we know" summary={prov.line} open={howOpen} onToggle={() => setHowOpen((o) => !o)}>
        <Stack gap={2}>
          <Notice tone={prov.confident ? "ok" : "warn"}>{prov.confident ? "Reported by the feed" : "Partly modelled"}</Notice>
          {next && <Text variant="subhead" tone="secondary">{index.stationName(next.id)}: {etaProvenance(next.eta, next.etaRaw, next.sigma)}</Text>}
          <Text variant="code" tone="tertiary">
            trip {state.trainId ?? state.id}{state.track ? ` · track ${state.track}` : ""}{state.assigned ? "" : " · unassigned"}
          </Text>
        </Stack>
      </Disclosure>
    </section>
  );
}
