"use client";

import { useEffect, useState } from "react";
import type { FeedStatus, TrainState } from "@/lib/types";
import type { NetworkIndex } from "@/lib/network";
import type { StreamMode, StreamStatus } from "@/lib/useTrainStream";
import { asset } from "@/lib/basePath";

interface Props {
  index: NetworkIndex;
  trains: TrainState[];
  feeds: FeedStatus[];
  status: StreamStatus;
  mode: StreamMode;
  onMode: (m: StreamMode) => void;
  visible: Set<string>;
  onToggle: (route: string, solo: boolean) => void;
  onAll: (on: boolean) => void;
  showRibbons: boolean;
  onRibbons: (on: boolean) => void;
  clock: () => number;
}

// Display grouping by trunk line, roughly following the official map.
const GROUPS: string[][] = [
  ["1", "2", "3"], ["4", "5", "6", "6X"], ["7", "7X"], ["A", "C", "E"], ["B", "D", "F", "FX", "M"],
  ["N", "Q", "R", "W"], ["G"], ["J", "Z"], ["L"], ["GS", "FS", "H", "SI"],
];

interface TimingInfo { learned: boolean; model: boolean; tables?: { generatedAt: string; samples: { events: number; etaObs: number }; runTime: number; residual: number } | null }
interface Recordings { from: number; to: number; ticks: number }

const nyClock = (ts: number) => new Date(ts * 1000).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit", second: "2-digit" });
const toLocalInput = (ts: number) => {
  const d = new Date(ts * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export default function Panel({ index, trains, feeds, status, mode, onMode, visible, onToggle, onAll, showRibbons, onRibbons, clock }: Props) {
  const [timing, setTiming] = useState<TimingInfo | null>(null);
  const [recordings, setRecordings] = useState<Recordings | null>(null);
  const [showReplay, setShowReplay] = useState(false);
  const [from, setFrom] = useState("");
  const [duration, setDuration] = useState(900);
  const [speed, setSpeed] = useState(10);
  const [now, setNow] = useState(0);
  const [wall, setWall] = useState(0);

  useEffect(() => {
    const id = setInterval(() => { setNow(clock()); setWall(Date.now() / 1000); }, 500);
    return () => clearInterval(id);
  }, [clock]);

  const source = status.source;
  useEffect(() => {
    if (source !== "poller") return;
    const load = () => {
      fetch(asset("/api/poller/timing")).then((r) => r.json()).then(setTiming).catch(() => setTiming(null));
      fetch(asset("/api/poller/recordings")).then((r) => (r.ok ? r.json() : Promise.reject(r.status))).then((r: Recordings) => {
        setRecordings(r);
        setFrom((f) => f || toLocalInput(Math.max(r.from, r.to - 900)));
      }).catch(() => setRecordings(null));
    };
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [source]);

  const counts: Record<string, number> = {};
  for (const t of trains) counts[t.route] = (counts[t.route] ?? 0) + 1;
  const total = trains.length;
  const shown = trains.filter((t) => visible.has(t.route)).length;
  const feedsDown = feeds.filter((f) => !f.ok);
  const age = status.clockTs && wall ? Math.max(0, Math.round(wall - status.clockTs)) : null;
  const healthy = status.connected && !feedsDown.length && (age === null || age < 60 || !status.live);

  const pollerTiming = source === "poller" ? timing : null;
  const play = () => {
    const f = Math.floor(new Date(from).getTime() / 1000);
    if (!Number.isFinite(f)) return;
    onMode({ kind: "replay", from: f, to: f + duration, speed });
  };

  return (
    <aside className="panel">
      <header className="panel-head">
        <div className="title-row">
          <h1>traintime</h1>
          <span className={`mode ${status.live ? "live" : "replay"}`}>{status.live ? "LIVE" : `REPLAY ${status.speed}×`}</span>
        </div>
        <div className="status">
          <span className={`dot ${healthy ? "ok" : "bad"}`} />
          <span>
            {status.connected || total ? `${shown === total ? total : `${shown} / ${total}`} trains` : (status.error ?? "connecting…")}
            {status.live && age !== null ? ` · feed ${age < 2 ? "just now" : `${age}s ago`}` : ""}
            {!status.live && status.clockTs ? ` · ${nyClock(now)}${status.ended ? " · ended" : ""}` : ""}
          </span>
        </div>
        {feedsDown.length > 0 && <div className="warn">feed down: {feedsDown.map((f) => f.id.replace("gtfs-", "")).join(", ")}</div>}
        {status.error && status.connected === false && total > 0 && <div className="warn">{status.error}</div>}
      </header>

      <div className="routes">
        {GROUPS.map((group, gi) => (
          <div className="group" key={gi}>
            {group.filter((id) => index.net.routes[id]).map((id) => {
              const r = index.net.routes[id];
              const on = visible.has(id);
              return (
                <button
                  key={id}
                  className={`bullet ${on ? "on" : "off"}`}
                  style={{ background: r.color, color: r.textColor }}
                  title={`${r.name}${counts[id] ? ` · ${counts[id]} running` : ""} — click to toggle, shift-click to solo`}
                  onClick={(e) => onToggle(id, e.shiftKey)}
                >
                  {id.replace(/X$/, "")}
                  {id.endsWith("X") && <sup>x</sup>}
                  {counts[id] ? <span className="count">{counts[id]}</span> : null}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      <div className="panel-row">
        <button onClick={() => onAll(true)}>all</button>
        <button onClick={() => onAll(false)}>none</button>
        <label className="check"><input type="checkbox" checked={showRibbons} onChange={(e) => onRibbons(e.target.checked)} /> uncertainty</label>
        {source === "poller" && <button className={`link ${showReplay ? "active" : ""}`} onClick={() => setShowReplay((s) => !s)}>replay</button>}
      </div>

      {showReplay && source === "poller" && (
        <div className="replay">
          <div className="replay-grid">
            <label>from<input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
            <label>for
              <select value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
                <option value={300}>5 min</option><option value={900}>15 min</option><option value={3600}>1 h</option><option value={10800}>3 h</option>
              </select>
            </label>
            <label>speed
              <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
                {[1, 5, 10, 30, 60].map((s) => <option key={s} value={s}>{s}×</option>)}
              </select>
            </label>
          </div>
          <div className="panel-row">
            <button className="primary" onClick={play} disabled={!(source === "poller" && recordings?.ticks)}>play</button>
            <button onClick={() => onMode({ kind: "live" })} disabled={mode.kind === "live"}>back to live</button>
            <span className="hint">
              {recordings?.ticks ? `recorded ${nyClock(recordings.from)} – ${nyClock(recordings.to)}` : "no recordings yet"}
            </span>
          </div>
        </div>
      )}

      <footer className="panel-foot">
        <span className="hint">
          {source === "browser"
            ? "tracking in this browser from the MTA feeds · learned timing snapshot"
            : source === "poller"
              ? `timing: ${pollerTiming ? (pollerTiming.learned ? `learned${pollerTiming.model ? " + model" : ""} · ${pollerTiming.tables?.samples.events.toLocaleString()} events` : "schedule defaults") : "…"}`
              : "connecting…"}
        </span>
      </footer>
    </aside>
  );
}
