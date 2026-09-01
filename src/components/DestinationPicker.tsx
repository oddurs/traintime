"use client";

import { useMemo, useState } from "react";
import type { NetworkIndex } from "@/lib/network";
import { searchStations } from "@/lib/arrivals";
import { Button, Field, IconButton, Row } from "./ui";
import RouteBullet from "./RouteBullet";

interface Props {
  index: NetworkIndex;
  destination?: string;
  onChange: (id: string | null) => void;
}

/** How many destinations to offer: enough to recognise one, few enough to read at a glance. */
const RESULTS = 5;

/** Turns a station board into a journey: pick where you are going and the rows answer that. */
export default function DestinationPicker({ index, destination, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const results = useMemo(() => (q ? searchStations(index, q, RESULTS) : []), [index, q]);

  if (destination) {
    return (
      <div className="dest-chip">
        <span>to <b>{index.stationName(destination)}</b></span>
        <IconButton icon="xmark" onClick={() => onChange(null)} ariaLabel="Clear destination" />
      </div>
    );
  }

  if (!open) {
    return (
      <Button variant="tinted" start icon="plus" onClick={() => setOpen(true)}>
        where are you going?
      </Button>
    );
  }

  const choose = (id: string) => { onChange(id); setOpen(false); setQ(""); };

  return (
    <Field
      bare
      autoFocus
      value={q}
      onChange={setQ}
      placeholder="Destination station…"
      ariaLabel="Destination station"
      onKeyDown={(e) => {
        if (e.key === "Escape") { setOpen(false); setQ(""); }
        if (e.key === "Enter" && results[0]) choose(results[0].id);
      }}
    >
      {results.length > 0 && (
        <ul className="popover">
          {results.map((r) => (
            <Row
              key={r.id}
              onClick={() => choose(r.id)}
              title={r.name}
              trailing={
                <span className="res-routes">
                  {r.routes.slice(0, 5).map((rt) => <RouteBullet key={rt} index={index} route={rt} size="sm" />)}
                </span>
              }
            />
          ))}
        </ul>
      )}
    </Field>
  );
}
