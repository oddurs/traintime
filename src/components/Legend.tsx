"use client";

interface Props {
  onDismiss: () => void;
}

/** One reading of the map's visual language, dismissed for good once understood. */
export default function Legend({ onDismiss }: Props) {
  return (
    <div className="legend" role="note">
      <div className="legend-rows">
        <span className="legend-row"><i className="swatch dot" /> at a station — confirmed by the feed</span>
        <span className="legend-row"><i className="swatch chev" /> moving — points the way it is going</span>
        <span className="legend-row"><i className="swatch glow" /> glow — where it might be, ±1σ</span>
        <span className="legend-row"><i className="swatch hold" /> amber ring — holding for a signal or the train in front</span>
        <span className="legend-row"><i className="swatch ghost" /> faded — assigned but not yet in service</span>
        <span className="legend-row"><i className="swatch stalefade" /> dimmed — the feed has stopped revising it</span>
      </div>
      <button className="legend-x" onClick={onDismiss} aria-label="Dismiss legend">Got it</button>
    </div>
  );
}
