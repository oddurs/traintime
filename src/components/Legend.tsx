/**
 * The map's visual language. One row for each thing a train can be — the statuses in TrainStatus —
 * plus the glow, which is about where it is rather than what.
 *
 * It used to be a card at the top of every first visit, with a button to dismiss it. It is now
 * inside the Lines group, where someone who is wondering what a ring means will look, and out of
 * the way of everyone who is not.
 */
const ROWS: { swatch: string; text: string }[] = [
  { swatch: "dot", text: "at a platform — confirmed by the feed" },
  { swatch: "chev", text: "running — points the way it is going" },
  { swatch: "glow", text: "glow — where it might be, ±1σ" },
  { swatch: "hold", text: "amber ring — held: 2 min or more past due" },
  { swatch: "ghost", text: "hollow — not in service yet" },
  { swatch: "stalefade", text: "faded — lost: the feed has stopped making sense of it" },
];

export default function Legend() {
  return (
    <div className="legend-rows" role="note" aria-label="Map key">
      {ROWS.map((r) => (
        <span className="legend-row" key={r.swatch}>
          <i className={`swatch ${r.swatch}`} aria-hidden="true" /> {r.text}
        </span>
      ))}
    </div>
  );
}
