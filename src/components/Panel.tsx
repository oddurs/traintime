"use client";

import { useEffect, useMemo, useState } from "react";
import type { FeedStatus, Selection, TrainPosition, TrainState } from "@/lib/types";
import type { NetworkIndex } from "@/lib/network";
import type { AlertIndex } from "@/lib/alerts";
import { routeStatus } from "@/lib/alerts";
import type { StreamMode, StreamStatus } from "@/lib/useTrainStream";
import { BoundClient } from "@/lib/client";
import { fmtAgo, fmtClockSec } from "@/lib/format";
import { useStoredFlag } from "@/lib/hooks";
import { BASE_PATH, POLLER_URL } from "@/lib/basePath";
import { markTiming, reportClientFailures } from "@/lib/clientHealth";
import { TRUNKS } from "@/lib/trunks";
import { Button, Chip, Notice, Section, Switch } from "./ui";
import Sheet from "./Sheet";
import SearchBox from "./SearchBox";
import StationBoard from "./StationBoard";
import TrainDetail from "./TrainDetail";
import { BoundMark, RouteBullet } from "./brand";
import { BRAND_NAME } from "@/lib/brand";
import { LEGEND_KEY } from "@/lib/firstPaint";
import { loadPhase, loadingHint } from "@/lib/loading";
import AlertList from "./AlertList";
import Legend from "./Legend";
import SavedPlaces from "./SavedPlaces";
import Timeline from "./Timeline";
import LineHealth from "./LineHealth";

interface Props {
  /**
   * Null until the board's half of the network has arrived. The panel is drawn without it — the
   * mark, the search field, every service's bullet — so the first paint is the panel itself and
   * not a loading screen that is later swapped for it.
   */
  index: NetworkIndex | null;
  /** The network could not be fetched; offer to try again rather than wait forever. */
  failed?: () => void;
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
  nearby: boolean;
  onNearby: () => void;
  locating: boolean;
  distance?: number;
  destination?: string;
  onDestination: (id: string | null) => void;
  places: import("@/lib/places").SavedPlace[];
  /** Whether `places` has been read from storage yet; before that, its space is held instead. */
  placesLoaded: boolean;
  onToggleSave: (id: string, name: string) => void;
  isSaved: (id: string) => boolean;
}

/*
 * The services, grouped the way the map is: by trunk line.
 *
 * This used to be its own list, which agreed with the trunk table until it did not — it had the
 * Staten Island Railway filed under the shuttles, which is two boroughs and a ferry away from
 * being true. There is one description of how the network is organised and this reads it.
 */
const GROUPS: string[][] = Object.values(TRUNKS).map((t) => t.services);

/** The feed is late enough that the countdown should no longer be taken at face value. */
const FEED_STALE_S = 60;
/**
 * How long the first load runs before the panel says so. A first visit on slow 4G takes about five
 * seconds to the board; past eight, "loading" without comment starts to read as "stuck".
 */
const SLOW_MS = 8000;

export default function Panel(props: Props) {
  const { index, failed, trains, byId, positionsRef, feeds, status, now, wallNow, alerts, selection, onSelect,
    follow, onFollow, visible, onToggle, onAll, showRibbons, onRibbons, mode, onMode,
    nearby, onNearby, locating, distance, destination, onDestination, places, placesLoaded, onToggleSave, isSaved } = props;
  const [legendDismissed, setLegendDismissed] = useStoredFlag(LEGEND_KEY, false);
  const [showHistory, setShowHistory] = useState(false);
  const client = useMemo(() => new BoundClient(POLLER_URL), []);
  // Tell the poller when this browser fails, so /health can see the half of the system that does
  // not run on our own machine.
  useEffect(() => reportClientFailures(POLLER_URL), []);
  // The moment the panel can answer anything: a station searched for, a saved station's train.
  // Before it the panel is drawn but holds only what a first paint can know.
  useEffect(() => { if (index) markTiming("readable"); }, [index]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const t of trains) c[t.route] = (c[t.route] ?? 0) + 1;
    return c;
  }, [trains]);

  const shown = visible ? trains.filter((t) => visible.has(t.route)).length : trains.length;
  const feedsDown = feeds.filter((f) => !f.ok);
  const age = status.clockTs && wallNow ? Math.max(0, Math.round(wallNow - status.clockTs)) : null;
  // Nothing has arrived yet, and nothing has gone wrong either: the first seconds of every visit.
  const phase = loadPhase(index !== null, status);
  const waiting = phase !== "ready";
  const healthy = !waiting && status.connected && !feedsDown.length && (age === null || age < FEED_STALE_S || !status.live);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- a deadline measured from navigation, which render cannot read */
    if (!waiting) { setSlow(false); return; }
    const id = setTimeout(() => setSlow(true), SLOW_MS - performance.now());
    return () => clearTimeout(id);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [waiting]);
  const delayAlerts = useMemo(() => (alerts?.all ?? []).filter((a) => a.category === "delay"), [alerts]);
  const selectedTrain = selection.kind === "train" ? byId.get(selection.id) : undefined;

  /*
   * The head of the panel, in the order Apple Maps puts things.
   *
   * The search field is the first thing, and it is pinned: it used to be the first child of the
   * scrolling body, so opening a station scrolled the way to look one up off the top of the sheet.
   * Above it sits the mark and nothing else — no title bar, because the panel is the application
   * and does not need to say so.
   *
   * The running count moved to the foot. It is telemetry: interesting, and not what someone opened
   * the app to find out. What stays here is trouble — a feed that is down, a stream that has
   * dropped — because chrome should be quiet while things are working and speak up when they are
   * not, which is the whole difference between a status bar and an alert.
   */
  const header = (
    <header className="panel-head">
      <div className="title-row">
        {/* Still the page's heading, even though it is drawn as a mark: the name is the h1. */}
        <h1>
          <a className="brandlink" href={`${BASE_PATH}/`} aria-label={`${BRAND_NAME} home`}>
            <BoundMark size="sm" />
          </a>
        </h1>
        {failed ? null : waiting
          ? <Chip tone="plain">Connecting</Chip>
          : <Chip tone={status.live ? "live" : "replay"}>{status.live ? "Live" : `Replay ${status.speed}×`}</Chip>}
      </div>
      <SearchBox
        index={index}
        onPick={(id) => onSelect({ kind: "station", id })}
        onNearby={onNearby}
        nearby={nearby}
        locating={locating}
      />
      {failed && (
        <div className="status">
          <Notice tone="bad" action={<Button variant="ghost" onClick={failed}>Try again</Button>}>
            Couldn’t load the stations.
          </Notice>
        </div>
      )}
      {!healthy && !waiting && (
        <div className="status">
          <Notice tone="bad">
            {status.connected || trains.length
              ? `${shown === trains.length ? trains.length : `${shown} / ${trains.length}`} trains`
              : (status.error ?? "connecting…")}
            {status.live && age !== null ? ` · feed ${age < 3 ? "just now" : `${age}s ago`}` : ""}
            {!status.live && status.clockTs ? ` · ${fmtClockSec(now)}${status.ended ? " · ended" : ""}` : ""}
          </Notice>
        </div>
      )}
      {feedsDown.length > 0 && (
        <div className="status">
          <Notice tone="warn">feed down: {feedsDown.map((f) => f.id.replace("gtfs-", "")).join(", ")}</Notice>
        </div>
      )}
    </header>
  );

  const footer = (
    <footer className="panel-foot">
      <span className="hint" role="status">
        {waiting ? loadingHint(phase, { failed: !!failed, slow }) : <>
        {healthy ? `${shown === trains.length ? trains.length : `${shown} / ${trains.length}`} trains · ` : ""}
        {status.source === "browser"
          ? `tracking in this browser · timing learned offline${status.modelReady ? " + model" : ""}`
          : status.source === "poller"
            ? `poller · ${alerts ? `alerts ${fmtAgo(wallNow - alerts.fetchedAt)}` : "live feeds"}`
            : "connecting…"}
        </>}
      </span>
      <a className="hint link-a" href={`${BASE_PATH}/accuracy/`}>how accurate?</a>
    </footer>
  );

  return (
    <Sheet
      raiseOn={selection.kind === "none" ? undefined : `${selection.kind}:${selection.id}`}
      header={header}
      footer={footer}
    >
      {selection.kind !== "none" && !index && <p className="muted">loading…</p>}
      {selection.kind === "station" && index && (
        <StationBoard
          index={index} station={selection.id} trains={trains} now={now} alerts={alerts}
          distance={distance}
          saved={isSaved(selection.id)}
          onToggleSave={() => onToggleSave(selection.id, index.stationName(selection.id))}
          destination={destination}
          onDestination={onDestination}
          stale={status.live && !status.connected && status.clockTs ? wallNow - status.clockTs : undefined}
          waiting={waiting}
          onSelect={onSelect} onClose={() => onSelect({ kind: "none" })}
        />
      )}

      {selection.kind === "train" && index && selectedTrain && (
        <TrainDetail
          index={index} state={selectedTrain} positionsRef={positionsRef} byId={byId} now={now} alerts={alerts} following={follow} onFollow={onFollow}
          onSelect={onSelect} onClose={() => onSelect({ kind: "none" })} destination={destination}
        />
      )}
      {selection.kind === "train" && index && !selectedTrain && waiting && <p className="muted">finding that train…</p>}
      {selection.kind === "train" && index && !selectedTrain && !waiting && (
        <p className="muted">
          That train has finished its run.{" "}
          <Button variant="ghost" onClick={() => onSelect({ kind: "none" })}>Back to the map</Button>
        </p>
      )}

      {selection.kind === "none" && (
        <>
          {!placesLoaded && <div className="saved-reserve" aria-hidden="true" />}
          <SavedPlaces index={index} places={places} trains={trains} now={now} waiting={waiting} onSelect={onSelect} />
          {!legendDismissed && <Legend onDismiss={() => setLegendDismissed(true)} />}

          <div className="routes" role="group" aria-label="Show or hide routes">
            {GROUPS.map((group, gi) => (
              <div className="group" key={gi}>
                {group.filter((id) => !index || index.net.routes[id]).map((id) => {
                  const on = !visible || visible.has(id);
                  const alert = routeStatus(alerts, id);
                  return (
                    <span className={`route-toggle${on ? "" : " is-off"}`} key={id}>
                      <RouteBullet
                        index={index} route={id} size="xl" dim={!on}
                        title={`${index?.net.routes[id].name ?? id}${counts[id] ? ` · ${counts[id]} running` : ""}${alert ? ` · ${alert.count} service alert${alert.count > 1 ? "s" : ""}` : ""} — click to toggle, shift-click to isolate`}
                        onClick={index ? (e) => onToggle(id, e.shiftKey) : undefined}
                      >
                        {alert && <span className={`alert-pip ${alert.category}`} />}
                      </RouteBullet>
                      <em>{counts[id] || ""}</em>
                    </span>
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

          {showHistory && status.source === "poller" && index && (
            <section className="history">
              <Timeline client={client} mode={mode} onMode={onMode} now={now} live={status.live} />
              <LineHealth index={index} client={client} onSolo={(r) => onToggle(r, true)} />
            </section>
          )}

          {index && delayAlerts.length > 0 && (
            <Section className="alerts-section" title={`Service changes · ${delayAlerts.length} active`}>
              <AlertList index={index} alerts={delayAlerts} limit={3} />
            </Section>
          )}
        </>
      )}
    </Sheet>
  );
}
