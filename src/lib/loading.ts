import type { StreamStatus } from "./useTrainStream";

/**
 * Where a visit is in its first load, and what the panel says about it.
 *
 * `stations`: the board's half of the network has not arrived; nothing can be searched yet.
 * `connecting`: it has, and the stream has not delivered its first trains.
 * `ready`: trains have arrived, or something has gone wrong and the panel's error lines say what.
 *
 * Kept apart from the panel because both mistakes it replaces were in this decision. The foot read
 * "0 trains · live feeds" under a Live chip the moment the stream opened, before a single train
 * had been received; and a failed fetch of the stations left "loading" on screen for good.
 */
export type LoadPhase = "stations" | "connecting" | "ready";

export function loadPhase(hasStations: boolean, status: Pick<StreamStatus, "error" | "messages">): LoadPhase {
  if (!hasStations) return "stations";
  // An error is not waiting: the stream dropped, and the panel reports that as the fault it is.
  if (!status.error && status.messages === 0) return "connecting";
  return "ready";
}

/** The foot's line while loading, or null once there is a running count to show instead. */
export function loadingHint(phase: LoadPhase, o: { failed: boolean; slow: boolean }): string | null {
  if (phase === "stations") {
    if (o.failed) return "stations not loaded";
    return o.slow ? "still loading — the connection is slow" : "loading stations…";
  }
  if (phase === "connecting") return o.slow ? "still connecting — the connection is slow" : "connecting to live trains…";
  return null;
}
