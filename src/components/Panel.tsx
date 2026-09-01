"use client";

import { useEffect, useMemo, useState } from "react";
import type { FeedStatus, Selection, TrainPosition, TrainState } from "@/lib/types";
import type { NetworkIndex } from "@/lib/network";
import type { AlertIndex } from "@/lib/alerts";
import { routeStatus } from "@/lib/alerts";
import type { StreamMode, StreamStatus } from "@/lib/useTrainStream";
import { TrainTimeClient } from "@/lib/client";
import { fmtAgo, fmtClockSec } from "@/lib/format";
import { useStoredFlag } from "@/lib/hooks";
import { BASE_PATH, POLLER_URL } from "@/lib/basePath";
import { reportClientFailures } from "@/lib/clientHealth";
import { Button, Chip, Notice, Section, Switch } from "./ui";
import Sheet from "./Sheet";
import SearchBox from "./SearchBox";
import StationBoard from "./StationBoard";
import TrainDetail from "./TrainDetail";
import RouteBullet from "./RouteBullet";
import AlertList from "./AlertList";
import Legend from "./Legend";
import SavedPlaces from "./SavedPlaces";
import Timeline from "./Timeline";
import LineHealth from "./LineHealth";

interface Props {
  index: NetworkIndex;
  trains: TrainState[];
  byId: Map<string, TrainState>;
  positionsRef: React.RefObject<Map<string, TrainPosition>>;
  feeds: FeedStatus[];
  status: StreamStatus;
  now: number;
  wallNow: number;
  alerts: AlertIndex | null;
  selection: Selection;
  onSelect: (s: Selection) => void;
  follow: boolean;
  onFollow: (on: boolean) => void;
  visible: Set<string> | null;
  onToggle: (route: string, solo: boolean) => void;
  onAll: (on: boolean) => void;
  showRibbons: boolean;
  onRibbons: (on: boolean) => void;
  mode: StreamMode;
  onMode: (m: StreamMode) => void;
  mobile: boolean;
  nearby: boolean;
  onNearby: () => void;
  locating: boolean;
  distance?: number;
  destination?: string;
  onDestination: (id: string | null) => void;
  places: import("@/lib/places").SavedPlace[];
  onToggleSave: (id: string, name: string) => void;
  isSaved: (id: string) => boolean;
}

// Display grouping by trunk line, roughly following the official map.
const GROUPS: string[][] = [
  ["1", "2", "3"], ["4", "5", "6", "6X"], ["7", "7X"], ["A", "C", "E"], ["B", "D", "F", "FX", "M"],
  ["N", "Q", "R", "W"], ["G"], ["J", "Z"], ["L"], ["GS", "FS", "H", "SI"],
];

/** The feed is late enough that the countdown should no longer be taken at face value. */
const FEED_STALE_S = 60;

export default function Panel(props: Props) {
  const { index, trains, byId, positionsRef, feeds, status, now, wallNow, alerts, selection, onSelect,
    follow, onFollow, visible, onToggle, onAll, showRibbons, onRibbons, mode, onMode, mobile,
    nearby, onNearby, locating, distance, destination, onDestination, places, onToggleSave, isSaved } = props;
  const [legendDismissed, setLegendDismissed] = useStoredFlag("tt.legend.dismissed", false);
  const [showHistory, setShowHistory] = useState(false);
  const client = useMemo(() => new TrainTimeClient(POLLER_URL), []);
  // Tell the poller when this browser fails, so /health can see the half of the system that does
  // not run on our own machine.
  useEffect(() => reportClientFailures(POLLER_URL), []);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const t of trains) c[t.route] = (c[t.route] ?? 0) + 1;
    return c;
  }, [trains]);

  const shown = visible ? trains.filter((t) => visible.has(t.route)).length : trains.length;
  const feedsDown = feeds.filter((f) => !f.ok);
  const age = status.clockTs && wallNow ? Math.max(0, Math.round(wallNow - status.clockTs)) : null;
  const healthy = status.connected && !feedsDown.length && (age === null || age < FEED_STALE_S || !status.live);
  const delayAlerts = useMemo(() => (alerts?.all ?? []).filter((a) => a.category === "delay"), [alerts]);
  const selectedTrain = selection.kind === "train" ? byId.get(selection.id) : undefined;

  const header = (
    <header className="panel-head">
      <div className="title-row">
        <h1><a href={`${BASE_PATH}/`} aria-label="traintime home">traintime</a></h1>
        <Chip tone={status.live ? "live" : "replay"}>{status.live ? "Live" : `Replay ${status.speed}×`}</Chip>
      </div>
      <div className="status">
        <Notice tone={healthy ? "ok" : "bad"}>
          {status.connected || trains.length
            ? `${shown === trains.length ? trains.length : `${shown} / ${trains.length}`} trains`
            : (status.error ?? "connecting…")}
          {status.live && age !== null ? ` · feed ${age < 3 ? "just now" : `${age}s ago`}` : ""}
          {!status.live && status.clockTs ? ` · ${fmtClockSec(now)}${status.ended ? " · ended" : ""}` : ""}
        </Notice>
      </div>
      {feedsDown.length > 0 && (
        <div className="status">
          <Notice tone="warn">feed down: {feedsDown.map((f) => f.id.replace("gtfs-", "")).join(", ")}</Notice>
        </div>
      )}
    </header>
  );

  const footer = (
    <footer className="panel-foot">
      <span className="hint">
        {status.source === "browser"
          ? `tracking in this browser · timing learned offline${status.modelReady ? " + model" : ""}`
          : status.source === "poller"
            ? `poller · ${alerts ? `alerts ${fmtAgo(wallNow - alerts.fetchedAt)}` : "live feeds"}`
            : "connecting…"}
      </span>
      <a className="hint link-a" href={`${BASE_PATH}/accuracy/`}>how accurate?</a>
    </footer>
  );

  return (
    <Sheet
      mobile={mobile}
      raiseOn={selection.kind === "none" ? undefined : `${selection.kind}:${selection.id}`}
      header={header}
      footer={footer}
    >
      <SearchBox
        index={index}
        onPick={(id) => onSelect({ kind: "station", id })}
        onNearby={onNearby}
        nearby={nearby}
        locating={locating}
      />

      {selection.kind === "station" && (
        <StationBoard
          index={index} station={selection.id} trains={trains} now={now} alerts={alerts}
          distance={distance}
          saved={isSaved(selection.id)}
          onToggleSave={() => onToggleSave(selection.id, index.stationName(selection.id))}
          destination={destination}
          onDestination={onDestination}
          stale={status.live && !status.connected && status.clockTs ? wallNow - status.clockTs : undefined}
          onSelect={onSelect} onClose={() => onSelect({ kind: "none" })} positionsRef={positionsRef}
        />
      )}

      {selection.kind === "train" && selectedTrain && (
        <TrainDetail
          index={index} state={selectedTrain} positionsRef={positionsRef} byId={byId} now={now} alerts={alerts} following={follow} onFollow={onFollow}
          onSelect={onSelect} onClose={() => onSelect({ kind: "none" })} destination={destination}
        />
      )}
      {selection.kind === "train" && !selectedTrain && (
        <p className="muted">
          That train has finished its run.{" "}
          <Button variant="ghost" onClick={() => onSelect({ kind: "none" })}>Back to the map</Button>
        </p>
      )}

      {selection.kind === "none" && trains.length === 0 && (
        <div className="skeleton" aria-hidden="true"><i /><i /><i /></div>
      )}

      {selection.kind === "none" && (
        <>
          <SavedPlaces index={index} places={places} trains={trains} now={now} onSelect={onSelect} />
          {!legendDismissed && trains.length > 0 && <Legend onDismiss={() => setLegendDismissed(true)} />}

          <div className="routes" role="group" aria-label="Show or hide routes">
            {GROUPS.map((group, gi) => (
              <div className="group" key={gi}>
                {group.filter((id) => index.net.routes[id]).map((id) => {
                  const on = !visible || visible.has(id);
                  const alert = routeStatus(alerts, id);
                  return (
                    <RouteBullet
                      key={id} index={index} route={id} size="xl" dim={!on}
                      title={`${index.net.routes[id].name}${counts[id] ? ` · ${counts[id]} running` : ""}${alert ? ` · ${alert.count} service alert${alert.count > 1 ? "s" : ""}` : ""} — click to toggle, shift-click to isolate`}
                      onClick={(e) => onToggle(id, e.shiftKey)}
                    >
                      {counts[id] ? <span className="count">{counts[id]}</span> : null}
                      {alert && <span className={`alert-pip ${alert.category}`} />}
                    </RouteBullet>
                  );
                })}
              </div>
            ))}
          </div>

          <div className="toolbar">
            <Button onClick={() => onAll(true)}>all</Button>
            <Button onClick={() => onAll(false)}>none</Button>
            <Switch checked={showRibbons} onChange={onRibbons}>uncertainty</Switch>
            {status.source === "poller" && (
              <span className="toolbar-end">
                <Button variant="ghost" on={showHistory} onClick={() => setShowHistory((s) => !s)} ariaExpanded={showHistory}>
                  history
                </Button>
              </span>
            )}
          </div>

          {showHistory && status.source === "poller" && (
            <section className="history">
              <Timeline client={client} mode={mode} onMode={onMode} now={now} live={status.live} />
              <LineHealth index={index} client={client} onSolo={(r) => onToggle(r, true)} />
            </section>
          )}

          {delayAlerts.length > 0 && (
            <Section className="alerts-section" title={`Service changes · ${delayAlerts.length} active`}>
              <AlertList index={index} alerts={delayAlerts} limit={3} />
            </Section>
          )}
        </>
      )}
    </Sheet>
  );
}
