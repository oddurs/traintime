"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type GeoStatus = "idle" | "asking" | "watching" | "denied" | "unavailable";

export interface GeoState {
  status: GeoStatus;
  lat?: number;
  lon?: number;
  /** Metres of horizontal accuracy reported by the device. */
  accuracy?: number;
  updatedAt?: number;
}

/**
 * Follows the device's position while `on`, which is what makes the app useful to someone
 * walking to a platform rather than sitting at a desk. Stops watching as soon as it is
 * switched off, because a live GPS watch is expensive.
 */
export function useGeolocation(on: boolean) {
  const [state, setState] = useState<GeoState>({ status: "idle" });
  const watchRef = useRef<number | null>(null);

  const stop = useCallback(() => {
    if (watchRef.current !== null && typeof navigator !== "undefined") {
      navigator.geolocation.clearWatch(watchRef.current);
      watchRef.current = null;
    }
  }, []);

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- mirrors the state of a device watch, which only exists as a side effect */
    if (!on) {
      stop();
      setState((s) => (s.status === "watching" || s.status === "asking" ? { ...s, status: "idle" } : s));
      return;
    }
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setState({ status: "unavailable" });
      return;
    }
    setState((s) => ({ ...s, status: s.lat === undefined ? "asking" : "watching" }));
    /* eslint-enable react-hooks/set-state-in-effect */
    watchRef.current = navigator.geolocation.watchPosition(
      (pos) =>
        setState({
          status: "watching",
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          updatedAt: Date.now() / 1000,
        }),
      (err) => setState({ status: err.code === err.PERMISSION_DENIED ? "denied" : "unavailable" }),
      { enableHighAccuracy: true, maximumAge: 15_000, timeout: 20_000 },
    );
    return stop;
  }, [on, stop]);

  return state;
}

/** Keeps the screen awake while following a train — the reason you are holding the phone up. */
export function useWakeLock(active: boolean) {
  useEffect(() => {
    if (!active || typeof navigator === "undefined" || !("wakeLock" in navigator)) return;
    let released = false;
    let lock: { release: () => Promise<void> } | null = null;
    const request = async () => {
      try {
        lock = await (navigator as Navigator & { wakeLock: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> } })
          .wakeLock.request("screen");
      } catch { /* denied or unsupported; not worth telling the user */ }
    };
    request();
    const onVisible = () => { if (document.visibilityState === "visible" && !released) request(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      released = true;
      document.removeEventListener("visibilitychange", onVisible);
      lock?.release().catch(() => {});
    };
  }, [active]);
}
