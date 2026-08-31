"use client";

import { useMemo, useState } from "react";
import type { FeedStatus, Selection, TrainPosition, TrainState } from "@/lib/types";
import type { NetworkIndex } from "@/lib/network";
import type { AlertIndex } from "@/lib/alerts";
import { routeStatus } from "@/lib/alerts";
import type { StreamMode, StreamStatus } from "@/lib/useTrainStream";
import { TrainTimeClient } from "@/lib/client";
import { fmtAgo, fmtClockSec } from "@/lib/format";
import { useStoredFlag } from "@/lib/hooks";
import { BASE_PATH, POLLER_URL } from "@/lib/basePath";
import Sheet from "./Sheet";
import SearchBox from "./SearchBox";
import StationBoard from "./StationBoard";
import TrainDetail from "./TrainDetail";
import RouteBullet from "./RouteBullet";
import AlertList from "./AlertList";
import Legend from "./Legend";
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
}

// Display grouping by trunk line, roughly following the official map.
const GROUPS: string[][] = [
  ["1", "2", "3"], ["4", "5", "6", "6X"], ["7", "7X"], ["A", "C", "E"], ["B", "D", "F", "FX", "M"],
  ["N", "Q", "R", "W"], ["G"], ["J", "Z"], ["L"], ["GS", "FS", "H", "SI"],
];

export default function Panel(props: Props) {
  const { index, trains, byId, positionsRef, feeds, status, now, wallNow, alerts, selection, onSelect,
    follow, onFollow, visible, onToggle, onAll, showRibbons, onRibbons, mode, onMode, mobile } = props;
  const [legendDismissed, setLegendDismissed] = useStoredFlag("tt.legend.dismissed", false);
  const [showHistory, setShowHistory] = useState(false);
  const client = useMemo(() => new TrainTimeClient(POLLER_URL), []);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const t of trains) c[t.route] = (c[t.route] ?? 0) + 1;
    return c;
  }, [trains]);

  const shown = visible ? trains.filter((t) => visible.has(t.route)).length : trains.length;
  const feedsDown = feeds.filter((f) => !f.ok);
  const age = status.clockTs && wallNow ? Math.max(0, Math.round(wallNow - status.clockTs)) : null;
  const healthy = status.connected && !feedsDown.length && (age === null || age < 60 || !status.live);
  const delayAlerts = useMemo(() => (alerts?.all ?? []).filter((a) => a.category === "delay"), [alerts]);
  const selectedTrain = selection.kind === "train" ? byId.get(selection.id) : undefined;

  const header = (
    <header className="panel-head">
      <div className="title-row">
        <h1><a href={`${BASE_PATH}/`} aria-label="traintime home">traintime</a></h1>
        <span className={`mode ${status.live ? "live" : "replay"}`}>
          {status.live ? "LIVE" : `REPLAY ${status.speed}×`}
        </span>
      </div>
      <div className="status">
        <span className={`dot ${healthy ? "ok" : "bad"}`} />
        <span>
          {status.connected || trains.length
            ? `${shown === trains.length ? trains.length : `${shown} / ${trains.length}`} trains`
            : (status.error ?? "connecting…")}
          {status.live && age !== null ? ` · feed ${age < 3 ? "just now" : `${age}s ago`}` : ""}
          {!status.live && status.clockTs ? ` · ${fmtClockSec(now)}${status.ended ? " · ended" : ""}` : ""}
        </span>
      </div>
      {feedsDown.length > 0 && <div className="warn">feed down: {feedsDown.map((f) => f.id.replace("gtfs-", "")).join(", ")}</div>}
    </header>
  );

  return (
    <Sheet mobile={mobile} raiseOn={selection.kind === "none" ? undefined : `${selection.kind}:${selection.id}`} header={header}>
      <SearchBox index={index} onPick={(id) => onSelect({ kind: "station", id })} />

      {selection.kind === "station" && (
        <StationBoard
          index={index} station={selection.id} trains={trains} now={now} alerts={alerts}
          onSelect={onSelect} onClose={() => onSelect({ kind: "none" })}
        />
      )}

      {selection.kind === "train" && selectedTrain && (
        <TrainDetail
          index={index} state={selectedTrain} positionsRef={positionsRef} byId={byId} now={now} alerts={alerts} following={follow} onFollow={onFollow}
          onSelect={onSelect} onClose={() => onSelect({ kind: "none" })}
        />
      )}
      {selection.kind === "train" && !selectedTrain && (
        <p className="muted">That train has finished its run. <button className="link" onClick={() => onSelect({ kind: "none" })}>Back to the map</button></p>
      )}

      {selection.kind === "none" && (
        <>
          {!legendDismissed && <Legend onDismiss={() => setLegendDismissed(true)} />}

          <div className="routes" role="group" aria-label="Show or hide routes">
            {GROUPS.map((group, gi) => (
              <div className="group" key={gi}>
                {group.filter((id) => index.net.routes[id]).map((id) => {
                  const on = !visible || visible.has(id);
                  const alert = routeStatus(alerts, id);
                  return (
                    <RouteBullet
                      key={id} index={index} route={id} size={30} dim={!on}
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

          <div className="panel-row">
            <button onClick={() => onAll(true)}>all</button>
            <button onClick={() => onAll(false)}>none</button>
            <label className="check">
              <input type="checkbox" checked={showRibbons} onChange={(e) => onRibbons(e.target.checked)} /> uncertainty
            </label>
            {status.source === "poller" && (
              <button className={`link ${showHistory ? "active" : ""}`} onClick={() => setShowHistory((s) => !s)}>
                history
              </button>
            )}
          </div>

          {showHistory && status.source === "poller" && (
            <section className="history">
              <Timeline client={client} mode={mode} onMode={onMode} now={now} live={status.live} />
              <LineHealth index={index} client={client} onSolo={(r) => onToggle(r, true)} />
            </section>
          )}

          {delayAlerts.length > 0 && (
            <section className="alerts-section">
              <h3>Service changes <span className="muted">· {delayAlerts.length} active</span></h3>
              <AlertList index={index} alerts={delayAlerts} limit={3} />
            </section>
          )}
        </>
      )}

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
    </Sheet>
  );
}
