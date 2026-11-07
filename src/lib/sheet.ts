export type SheetStop = "peek" | "half" | "full";
export const STOPS: SheetStop[] = ["peek", "half", "full"];

/** Faster than this, in points per millisecond, and the gesture is a flick: it means "the next stop". */
export const FLICK_V = 0.4;
/**
 * How far ahead a slower drag is projected, in milliseconds of its own speed, before the nearest
 * stop is chosen — so a drag that is still drifting when the finger lifts settles where it was going.
 */
export const PROJECT_MS = 180;
/** A finger that rested this long before lifting had stopped: its last speed no longer counts. */
export const REST_MS = 80;

/**
 * Where a released sheet goes.
 *
 * `height` is where the finger let go and `v` its speed in points per millisecond, positive
 * downwards (the way the screen counts). A flick goes one stop in the direction it was moving,
 * from the stop it is nearest; anything slower settles on the stop nearest where it was heading.
 * That is the rule a native sheet follows, and it is why a short quick swipe and a long slow drag
 * can end in the same place.
 */
export function snapStop(heights: Record<SheetStop, number>, height: number, v: number): SheetStop {
  const nearest = (h: number) =>
    STOPS.reduce((best, s) => (Math.abs(heights[s] - h) < Math.abs(heights[best] - h) ? s : best), STOPS[0]);
  if (Math.abs(v) >= FLICK_V) {
    // Up the screen is a taller sheet. Step from the stop below (or above) the finger, so a flick
    // that started just past a stop does not skip the one it was moving towards.
    const up = v < 0;
    const order = up ? STOPS : [...STOPS].reverse();
    const next = order.find((s) => (up ? heights[s] > height + 1 : heights[s] < height - 1));
    return next ?? order[order.length - 1];
  }
  return nearest(height - v * PROJECT_MS);
}
