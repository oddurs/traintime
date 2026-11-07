import { MapButton } from "./ui";

export type BadgeTone = "live" | "replay" | "wait" | "plain";

interface Props {
  /** Whether the rider has asked to be located. */
  locating: boolean;
  onLocate: () => void;
  badge: { tone: BadgeTone; text: string } | null;
}

/**
 * The controls that float over the map: where you are, and whether the trains are live.
 *
 * The status used to be a chip in the panel's title row, beside the brand, taking a line of the
 * card to say "Live" — which is what it says almost all of the time. It is a word on the map now,
 * in the corner, where it can be glanced at and otherwise ignored.
 */
export default function MapControls({ locating, onLocate, badge }: Props) {
  return (
    <div className="map-controls">
      <MapButton
        icon={locating ? "location.fill" : "location"} on={locating} onClick={onLocate} ariaPressed={locating}
        ariaLabel={locating ? "Stop using my location" : "Show trains near me"}
        title={locating ? "Stop using my location" : "Show trains near me"}
      />
      {badge && (
        <span className={`map-badge map-badge--${badge.tone}`} role="status">
          <i aria-hidden="true" />{badge.text}
        </span>
      )}
    </div>
  );
}
