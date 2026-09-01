"use client";

import { Button, Card } from "./ui";

interface Props {
  onDismiss: () => void;
}

/** The map's visual language, read once and dismissed for good. */
const ROWS: { swatch: string; text: string }[] = [
  { swatch: "dot", text: "at a station — confirmed by the feed" },
  { swatch: "chev", text: "moving — points the way it is going" },
  { swatch: "glow", text: "glow — where it might be, ±1σ" },
  { swatch: "hold", text: "amber ring — stopped: a signal, the train in front, or not moving at all" },
  { swatch: "ghost", text: "faded — assigned but not yet in service" },
  { swatch: "stalefade", text: "dimmed — the feed has stopped revising it" },
];

export default function Legend({ onDismiss }: Props) {
  return (
    <Card className="legend">
      <div className="legend-rows" role="note">
        {ROWS.map((r) => (
          <span className="legend-row" key={r.swatch}>
            <i className={`swatch ${r.swatch}`} aria-hidden="true" /> {r.text}
          </span>
        ))}
      </div>
      <span><Button onClick={onDismiss} ariaLabel="Dismiss legend">Got it</Button></span>
    </Card>
  );
}
