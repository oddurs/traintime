/**
 * "Get off here and take the other one."
 *
 * We hold a full per-stop prediction for every train in the system at the same moment, which is
 * the one thing a countdown clock or an in-car display cannot: they know about one train. That
 * makes a question answerable that nobody else can answer — given the train you are on and where
 * you are going, is there a train you should change to, and where?
 *
 * It is only offered when a destination has been named. Without one there is no journey to be
 * faster about, and "sooner to the end of my run" is not advice anyone can act on.
 */
import { parentOf, type NetworkIndex } from "./network";
import type { TrainState } from "./types";

/** Getting off, crossing, and getting on again is not instant. */
const MIN_TRANSFER_S = 75;
/** Below this, saying anything is noise dressed up as advice. */
const WORTH_SAYING_S = 120;

export interface Change {
  /** The complex to change at, and its name. */
  at: string;
  atName: string;
  /** When this train reaches it. */
  when: number;
  /** The train to change to. */
  toId: string;
  toRoute: string;
  /** How much sooner you would arrive, in seconds. */
  saving: number;
}

export function betterConnection(
  index: NetworkIndex,
  all: Iterable<TrainState>,
  riding: TrainState,
  destination: string,
  now: number,
): Change | undefined {
  const cx = (id: string) => index.complexKey(parentOf(id)) ?? parentOf(id);
  const dest = cx(destination);

  /** When a train calls at each complex, earliest call only. */
  const calls = (t: TrainState) => {
    const m = new Map<string, number>();
    for (const s of t.stops) { const k = cx(s.id); if (!m.has(k)) m.set(k, s.eta); }
    return m;
  };

  const mineCalls = calls(riding);
  const mine = mineCalls.get(dest);
  if (mine === undefined) return undefined;

  let best: Change | undefined;
  for (const other of all) {
    if (other.id === riding.id || other.route === riding.route) continue;
    if (other.status === "scheduled" || other.status === "lost") continue;
    const theirs = calls(other);
    const arrival = theirs.get(dest);
    if (arrival === undefined || arrival >= mine - WORTH_SAYING_S) continue;
    if (best && arrival >= mine - best.saving) continue;

    // The change has to be one you could actually make: somewhere this train still calls, that
    // the other one leaves late enough for you to cross to it.
    for (const [key, whenHere] of mineCalls) {
      if (key === dest || whenHere < now) continue;
      const theirCall = theirs.get(key);
      if (theirCall === undefined || theirCall < whenHere + MIN_TRANSFER_S) continue;
      // And changing there has to still get you in before staying put would.
      if (arrival >= mine) break;
      best = {
        at: key, atName: index.complexName(key) ?? index.stationName(key),
        when: whenHere, toId: other.id, toRoute: other.route, saving: mine - arrival,
      };
      break;
    }
  }
  return best;
}
