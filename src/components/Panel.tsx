"use client";

import { useEffect, useMemo, useState } from "react";
import type { FeedStatus, Selection, TrainPosition, TrainState } from "@/lib/types";
import type { NetworkIndex } from "@/lib/network";
import type { AlertIndex } from "@/lib/alerts";
import type { StreamMode, StreamStatus } from "@/lib/useTrainStream";
import type { GeoStatus } from "@/lib/geolocation";
import type { NearbyStation, RadiusMin } from "@/lib/nearby";
import { BoundClient } from "@/lib/client";
import { fmtAgo, fmtClockSec } from "@/lib/format";
import { BASE_PATH, POLLER_URL } from "@/lib/basePath";
import { markTiming, reportClientFailures } from "@/lib/clientHealth";
import { BRAND_NAME } from "@/lib/brand";
import { loadPhase, loadingHint } from "@/lib/loading";
import { Button, Inline, Notice, Section, Text } from "./ui";
import Sheet from "./Sheet";
import SearchBox from "./SearchBox";
import StationBoard from "./StationBoard";
import TrainDetail from "./TrainDetail";
import AlertList from "./AlertList";
import SavedPlaces from "./SavedPlaces";
import Nearby from "./Nearby";
import LinesCard from "./LinesCard";
import MapControls, { type BadgeTone } from "./MapControls";
import { useLineHealth } from "./LineHealth";

export interface NearbyProps {
  on: boolean;
  geo: GeoStatus;
  stations: NearbyStation[] | null;
  radius: RadiusMin;
  onRadius: (r: RadiusMin) => void;
  onLocate: () => void;
}

interface Props {
  /**
   * Null until the board's half of the network has arrived. The panel is drawn without it — the
   * search field, every service's bullet — so the first paint is the panel itself and not a
   * loading screen that is later swapped for it.
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
  nearby: NearbyProps;
  distance?: number;
  destination?: string;
  onDestination: (id: string | null) => void;
  places: import("@/lib/places").SavedPlace[];
  /** Whether `places` has been read from storage yet; before that, its space is held instead. */
  placesLoaded: boolean;
  onToggleSave: (id: string, name: string) => void;
  isSaved: (id: string) => boolean;
}

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
    nearby, distance, destination, onDestination, places, placesLoaded, onToggleSave, isSaved } = props;
  const client = useMemo(() => new BoundClient(POLLER_URL), []);
  // Tell the poller when this browser fails, so /health can see the half of the system that does
  // not run on our own machine.
  useEffect(() => reportClientFailures(POLLER_URL), []);
  // The moment the panel can answer anything: a station searched for, a saved station's train.
  useEffect(() => { if (index) markTiming("readable"); }, [index]);
  const health = useLineHealth(client, index, status.source === "poller");
  // Bumped when the search field takes focus, which on a phone opens the card all the way.
  const [searching, setSearching] = useState(0);

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

  // The one word of status kept on screen, over the map. Trouble is said in the card instead.
  const badge: { tone: BadgeTone; text: string } | null = failed ? null
    : phase === "stations" ? { tone: "wait", text: slow ? "Slow connection" : "Loading" }
    : phase === "connecting" ? { tone: "wait", text: slow ? "Slow connection" : "Connecting" }
    : !status.connected ? { tone: "wait", text: "Reconnecting" }
    : status.live ? { tone: "live", text: "Live" }
    : { tone: "replay", text: `Replay ${status.speed}×` };

  /*
   * The head of the card is the search field and nothing else, as it is in Maps: on a phone the
   * collapsed card is exactly this, and the map has the rest of the screen. The brand is the page's
   * heading for a screen reader and the word in the fine print for everyone else; it used to take
   * a line of its own, with the status chip beside it, above the one control anyone came to use.
   *
   * What does appear here is trouble — a failed load, a feed that is down, a stream that has
   * dropped — because chrome should be quiet while things are working and speak up when they are
   * not.
   */
  const header = (
    <header className="panel-head">
      <h1 className="sr-only">{BRAND_NAME} — live New York subway map</h1>
      <SearchBox index={index} onPick={(id) => onSelect({ kind: "station", id })} onFocus={() => setSearching((n) => n + 1)} />
      {failed && (
        <Notice tone="bad" action={<Button variant="ghost" onClick={failed}>Try again</Button>}>
          Couldn’t load the stations.
        </Notice>
      )}
      {!healthy && !waiting && (
        <Notice tone="bad">
          {status.connected || trains.length ? `${trains.length} trains` : (status.error ?? "connecting…")}
          {status.live && age !== null ? ` · feed ${age < 3 ? "just now" : `${age}s ago`}` : ""}
          {!status.live && status.clockTs ? ` · ${fmtClockSec(now)}${status.ended ? " · ended" : ""}` : ""}
        </Notice>
      )}
      {feedsDown.length > 0 && (
        <Notice tone="warn">feed down: {feedsDown.map((f) => f.id.replace("gtfs-", "")).join(", ")}</Notice>
      )}
    </header>
  );

  const foot = (
    <Inline as="footer" justify="between" wrap gap={3}>
      <span role="status">
        <Text variant="footnote" tone="tertiary">
          {waiting ? loadingHint(phase, { failed: !!failed, slow }) : <>
            {BRAND_NAME} · {status.source === "browser"
              ? `tracking in this browser${status.modelReady ? " · model" : ""}`
              : alerts ? `alerts ${fmtAgo(wallNow - alerts.fetchedAt)}` : "live feeds"}
          </>}
        </Text>
      </span>
      <a className="link-a" href={`${BASE_PATH}/accuracy/`}><Text variant="footnote">How accurate is this?</Text></a>
    </Inline>
  );

  return (
    <>
      <MapControls locating={nearby.on} onLocate={nearby.onLocate} badge={badge} />
      <Sheet
        raiseOn={selection.kind !== "none" ? `${selection.kind}:${selection.id}` : nearby.on ? "nearby" : undefined}
        expandOn={searching ? String(searching) : undefined}
        header={header}
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
            <Nearby
              index={index} stations={nearby.stations} geo={nearby.geo} on={nearby.on} onLocate={nearby.onLocate}
              radius={nearby.radius} onRadius={nearby.onRadius} now={now} waiting={waiting} onSelect={onSelect}
            />
            {!placesLoaded && <div className="saved-reserve" aria-hidden="true" />}
            <SavedPlaces index={index} places={places} trains={trains} now={now} waiting={waiting} onSelect={onSelect} />
            <LinesCard
              index={index} trains={trains} alerts={alerts} health={health}
              visible={visible} onToggle={onToggle} onAll={onAll} showRibbons={showRibbons} onRibbons={onRibbons}
              client={status.source === "poller" ? client : undefined} mode={mode} onMode={onMode} now={now} live={status.live}
            />
            {index && delayAlerts.length > 0 && (
              <Section title="Service changes">
                <AlertList index={index} alerts={delayAlerts} limit={3} />
              </Section>
            )}
          </>
        )}
        {foot}
      </Sheet>
    </>
  );
}
