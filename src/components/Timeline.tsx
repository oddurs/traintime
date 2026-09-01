"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { StreamMode } from "@/lib/useTrainStream";
import { TrainTimeClient, type DensityBucket, type Recordings } from "@/lib/client";
import { fmtClock } from "@/lib/format";
import { Button, Select } from "./ui";

interface Props {
  client: TrainTimeClient;
  mode: StreamMode;
  onMode: (m: StreamMode) => void;
  /** Simulation clock, for drawing the playhead during a replay. */
  now: number;
  live: boolean;
}

const WINDOWS = [
  { label: "5 min", secs: 300 },
  { label: "15 min", secs: 900 },
  { label: "1 h", secs: 3600 },
];
const SPEEDS = [1, 5, 10, 30, 60];

/** Drag through recorded history; the bars are arrivals, so rush hour is visible before you play. */
export default function Timeline({ client, mode, onMode, now, live }: Props) {
  const [rec, setRec] = useState<Recordings | null>(null);
  const [density, setDensity] = useState<DensityBucket[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [window_, setWindow] = useState(900);
  const [speed, setSpeed] = useState(10);
  const [recording, setRecording] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const r = await client.recordings();
      setRec(r);
      if (r.ticks > 0) {
        const d = await client.density(r.from, r.to, 100);
        setDensity(d.buckets);
        setCursor((c) => c ?? Math.max(r.from, r.to - window_));
      }
    } catch { setRec(null); }
  }, [client, window_]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch; state lands later
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [load]);

  const max = useMemo(() => Math.max(1, ...density.map((b) => b.arrivals)), [density]);
  const span = rec ? Math.max(1, rec.to - rec.from) : 1;
  const playhead = !live && rec ? ((now - rec.from) / span) * 100 : null;
  const cursorPct = rec && cursor !== null ? ((cursor - rec.from) / span) * 100 : 0;

  const pick = (clientX: number) => {
    const el = barRef.current;
    if (!el || !rec) return;
    const box = el.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (clientX - box.left) / box.width));
    setCursor(Math.round(rec.from + f * span));
  };

  const play = () => {
    if (cursor === null || !rec) return;
    onMode({ kind: "replay", from: cursor, to: Math.min(rec.to, cursor + window_), speed });
  };

  /** Record the map canvas through one replay and hand back a WebM. */
  const exportClip = async () => {
    const canvas = document.querySelector<HTMLCanvasElement>(".maplibregl-canvas");
    if (!canvas || cursor === null || !rec || recording) return;
    const stream = canvas.captureStream(30);
    const mime = ["video/webm;codecs=vp9", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m));
    if (!mime) return;
    const chunks: BlobPart[] = [];
    const mr = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000 });
    mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    mr.onstop = () => {
      const url = URL.createObjectURL(new Blob(chunks, { type: mime }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `traintime-${new Date(cursor * 1000).toISOString().slice(0, 16).replace(/[:T]/g, "-")}.webm`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setRecording(false);
    };
    setRecording(true);
    play();
    mr.start();
    setTimeout(() => mr.state !== "inactive" && mr.stop(), (window_ / speed) * 1000 + 1500);
  };

  if (!rec || rec.ticks === 0) {
    return <p className="muted hint">No recordings yet — the poller writes history as it runs.</p>;
  }

  return (
    <div className="timeline">
      <div
        className="tl-bar"
        ref={barRef}
        onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture(e.pointerId); pick(e.clientX); }}
        onPointerMove={(e) => e.buttons === 1 && pick(e.clientX)}
        role="slider"
        tabIndex={0}
        aria-label="Recorded history"
        aria-valuemin={rec.from}
        aria-valuemax={rec.to}
        aria-valuenow={cursor ?? rec.to}
        onKeyDown={(e) => {
          if (!cursor) return;
          if (e.key === "ArrowLeft") setCursor(Math.max(rec.from, cursor - 60));
          if (e.key === "ArrowRight") setCursor(Math.min(rec.to, cursor + 60));
        }}
      >
        {density.map((b, i) => (
          <i key={i} style={{ height: `${Math.max(4, (b.arrivals / max) * 100)}%` }} />
        ))}
        <span className="tl-cursor" style={{ left: `${cursorPct}%` }} />
        {playhead !== null && playhead >= 0 && playhead <= 100 && <span className="tl-playhead" style={{ left: `${playhead}%` }} />}
      </div>
      <div className="tl-scale">
        <span>{fmtClock(rec.from)}</span>
        <span>{cursor !== null ? fmtClock(cursor) : ""}</span>
        <span>{fmtClock(rec.to)}</span>
      </div>
      <div className="toolbar">
        <Button variant="filled" onClick={play}>play</Button>
        <Select
          value={window_} onChange={setWindow} parse={Number} ariaLabel="Replay length"
          options={WINDOWS.map((w) => ({ value: w.secs, label: w.label }))}
        />
        <Select
          value={speed} onChange={setSpeed} parse={Number} ariaLabel="Replay speed"
          options={SPEEDS.map((s) => ({ value: s, label: `${s}\u00d7` }))}
        />
        <Button onClick={exportClip} disabled={recording} title="Record this replay as a video">
          {recording ? "recording…" : "clip"}
        </Button>
        {mode.kind === "replay" && <Button onClick={() => onMode({ kind: "live" })}>live</Button>}
      </div>
    </div>
  );
}
