"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { NetworkIndex } from "@/lib/network";
import { searchStations } from "@/lib/arrivals";
import { Button, Field, IconButton, Row } from "./ui";
import { BulletGroup } from "./brand";

interface Props {
  /**
   * Null while the stations are still arriving. The field is live from the first paint anyway:
   * someone who knows where they are going starts typing, and what they typed is searched the
   * moment the names land, in the same field, without losing focus.
   */
  index: NetworkIndex | null;
  onPick: (stationId: string) => void;
  /** The field took focus: on a phone the card opens all the way, the way Maps does. */
  onFocus?: () => void;
  /**
   * What to offer before anything is typed: the rider's saved stations, then the ones they have
   * looked at lately. Most searches are for a station someone has been to before.
   */
  saved?: { id: string; name: string }[];
  recent?: { id: string; name: string }[];
  onClearRecent?: () => void;
}

type Group = "Saved" | "Recent";
type Result = { id: string; name: string; routes: string[]; meters?: number; group?: Group };

/** Station search. `/` focuses it from anywhere. */
export default function SearchBox({ index, onPick, onFocus, saved = [], recent = [], onClearRecent }: Props) {
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const results: Result[] = useMemo(() => {
    if (!index) return [];
    if (q) return searchStations(index, q);
    const savedIds = new Set(saved.map((p) => p.id));
    const row = (group: Group) => (p: { id: string; name: string }): Result => ({ id: p.id, name: p.name, routes: index.complexRoutes(p.id), group });
    return [...saved.map(row("Saved")), ...recent.filter((r) => !savedIds.has(r.id)).map(row("Recent"))];
  }, [index, q, saved, recent]);
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
    <Field
      value={q}
      onChange={(v) => { setQ(v); setCursor(0); setOpen(true); }}
      placeholder="Search stations"
      ariaLabel="Search stations"
      icon="magnifyingglass"
      inputRef={inputRef}
      boxRef={boxRef}
      onFocus={() => { setOpen(true); onFocus?.(); }}
      onKeyDown={onKeyDown}
      accessory={q ? (
        <IconButton icon="xmark" ariaLabel="Clear search" onClick={() => { setQ(""); inputRef.current?.focus(); }} />
      ) : undefined}
    >
      {open && q && !index && (
        <div className="popover" role="status"><div className="popover-empty">loading stations…</div></div>
      )}
      {open && index && q && results.length === 0 && (
        <div className="popover" role="status"><div className="popover-empty">No station called “{q.trim()}”</div></div>
      )}
      {open && index && results.length > 0 && (
        <ul className="popover" role="listbox" aria-label={q ? "Stations" : "Saved and recent stations"}>
          {results.map((r, i) => [
            r.group && r.group !== results[i - 1]?.group && (
              <li className="popover-head" role="presentation" key={`head-${r.group}`}>
                <span>{r.group}</span>
                {r.group === "Recent" && onClearRecent && (
                  <Button variant="ghost" onClick={() => { onClearRecent(); inputRef.current?.focus(); }}>Clear</Button>
                )}
              </li>
            ),
            <Row
              key={`${r.group ?? "match"}-${r.id}`}
              role="option"
              selected={i === active}
              active={i === active}
              onHover={() => setCursor(i)}
              onClick={() => pick(r)}
              title={r.name}
              trailing={
                <BulletGroup
                  index={index} routes={r.routes} size="sm" limit={6}
                  trailing={r.meters !== undefined ? <em>{r.meters < 1000 ? `${Math.round(r.meters)} m` : `${(r.meters / 1000).toFixed(1)} km`}</em> : undefined}
                />
              }
            />,
          ])}
        </ul>
      )}
    </Field>
  );
}
