"use client";

import { Button, Card } from "./ui";

interface Props {
  onDismiss: () => void;
}

/**
 * The map's visual language, read once and dismissed for good. One row for each thing a train can
 * be — the statuses in TrainStatus — plus the glow, which is about where it is rather than what.
 */
const ROWS: { swatch: string; text: string }[] = [
  { swatch: "dot", text: "at a platform — confirmed by the feed" },
  { swatch: "chev", text: "running — points the way it is going" },
  { swatch: "glow", text: "glow — where it might be, ±1σ" },
  { swatch: "hold", text: "amber ring — held: 2 min or more past due, between stations or at a platform" },
  { swatch: "ghost", text: "hollow — not in service yet: preparing for its trip at the terminal, or scheduled with no train" },
  { swatch: "stalefade", text: "faded — lost: the feed still lists it, but has stopped making sense of it" },
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
