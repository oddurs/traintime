"use client";

import { useMemo, useState } from "react";
import type { NetworkIndex } from "@/lib/network";
import { searchStations } from "@/lib/arrivals";
import RouteBullet from "./RouteBullet";

interface Props {
  index: NetworkIndex;
  destination?: string;
  onChange: (id: string | null) => void;
}

/** Turns a station board into a journey: pick where you are going and the rows answer that. */
export default function DestinationPicker({ index, destination, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const results = useMemo(() => (q ? searchStations(index, q, 5) : []), [index, q]);

  if (destination) {
    return (
      <div className="dest-chip">
        <span>to <b>{index.stationName(destination)}</b></span>
        <button className="icon-btn" onClick={() => onChange(null)} aria-label="Clear destination">×</button>
      </div>
    );
  }

  if (!open) {
    return (
      <button className="dest-add" onClick={() => setOpen(true)}>
        + where are you going?
      </button>
    );
  }

  return (
    <div className="dest-search">
      <input
        autoFocus
        value={q}
        placeholder="Destination station…"
        aria-label="Destination station"
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") { setOpen(false); setQ(""); }
          if (e.key === "Enter" && results[0]) { onChange(results[0].id); setOpen(false); setQ(""); }
        }}
      />
      {results.length > 0 && (
        <ul className="results">
          {results.map((r) => (
            <li key={r.id}>
              <button onClick={() => { onChange(r.id); setOpen(false); setQ(""); }}>
                <span className="res-name">{r.name}</span>
                <span className="res-routes">{r.routes.slice(0, 5).map((rt) => <RouteBullet key={rt} index={index} route={rt} size={16} />)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
