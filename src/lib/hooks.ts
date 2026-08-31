"use client";

import { useEffect, useState } from "react";

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setMatches(m.matches);
    on();
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, [query]);
  return matches;
}

export const useIsMobile = () => useMediaQuery("(max-width: 640px)");
export const useReducedMotion = () => useMediaQuery("(prefers-reduced-motion: reduce)");

/** A clock that ticks at `hz`, for countdowns that must stay live without re-rendering the map. */
export function useTicker(clock: () => number, hz = 2): number {
  const [now, setNow] = useState(() => clock());
  useEffect(() => {
    const id = setInterval(() => setNow(clock()), 1000 / hz);
    return () => clearInterval(id);
  }, [clock, hz]);
  return now;
}

/** Persisted boolean, e.g. "has the legend been dismissed". */
export function useStoredFlag(key: string, initial: boolean): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState(initial);
  useEffect(() => {
    let stored: boolean | null = null;
    try {
      const raw = localStorage.getItem(key);
      if (raw !== null) stored = raw === "1";
    } catch {}
    if (stored === null) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time read of a store that render cannot touch
    setValue(stored);
  }, [key]);
  const set = (v: boolean) => {
    setValue(v);
    try { localStorage.setItem(key, v ? "1" : "0"); } catch {}
  };
  return [value, set];
}
