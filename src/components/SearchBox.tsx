"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { NetworkIndex } from "@/lib/network";
import { searchStations } from "@/lib/arrivals";
import RouteBullet from "./RouteBullet";

interface Props {
  index: NetworkIndex;
  onPick: (stationId: string) => void;
  onNearby: () => void;
  nearby: boolean;
  locating: boolean;
}

type Result = { id: string; name: string; routes: string[]; meters?: number };

/** Station search with a "near me" shortcut. `/` focuses it from anywhere. */
export default function SearchBox({ index, onPick, onNearby, nearby, locating }: Props) {
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const results: Result[] = useMemo(() => (q ? searchStations(index, q) : []), [index, q]);
  const active = Math.min(cursor, Math.max(0, results.length - 1));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target && (target.tagName === "INPUT" || target.tagName === "SELECT" || target.isContentEditable);
      if (e.key === "/" && !typing) {
        e.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, []);

  const pick = (r: Result) => {
    onPick(r.id);
    setQ("");
    setOpen(false);
    inputRef.current?.blur();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { setOpen(false); inputRef.current?.blur(); return; }
    if (!results.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => (c + 1) % results.length); setOpen(true); }
    if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => (c - 1 + results.length) % results.length); setOpen(true); }
    if (e.key === "Enter") { e.preventDefault(); pick(results[active]); }
  };

  return (
    <div className="search" ref={boxRef}>
      <div className="search-row">
        <svg className="search-icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
        <input
          ref={inputRef}
          value={q}
          placeholder="Search stations…"
          aria-label="Search stations"
          onChange={(e) => { setQ(e.target.value); setCursor(0); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
        <button
          className={`near-btn ${nearby ? "on" : ""}`}
          onClick={onNearby}
          aria-pressed={nearby}
          title={nearby ? "Stop following my location" : "Show the station nearest me and keep it up to date"}
        >
          {locating ? "locating…" : nearby ? "following you" : "near me"}
        </button>
      </div>
      {open && results.length > 0 && (
        <ul className="results" role="listbox">
          {results.map((r, i) => (
            <li key={r.id} role="option" aria-selected={i === active}>
              <button className={i === active ? "on" : ""} onMouseEnter={() => setCursor(i)} onClick={() => pick(r)}>
                <span className="res-name">{r.name}</span>
                <span className="res-routes">
                  {r.routes.slice(0, 6).map((rt) => <RouteBullet key={rt} index={index} route={rt} size={16} />)}
                  {r.meters !== undefined && <em>{r.meters < 1000 ? `${Math.round(r.meters)} m` : `${(r.meters / 1000).toFixed(1)} km`}</em>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

    </div>
  );
}
