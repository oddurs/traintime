/**
 * Which way the trains on this list are going, and where they end up.
 *
 * Two lines, because they answer two questions a platform sign answers separately: the compass
 * direction, which is how the station is signed, and the last stop, which is how the train is
 * signed. A rider matches whichever of the two they happen to know.
 */
export default function DirectionHeading({ direction, toward }: { direction: string; toward?: string }) {
  return (
    <div className="dir">
      <h3>{direction}</h3>
      {toward && <span className="dir-toward">toward {toward}</span>}
    </div>
  );
}
