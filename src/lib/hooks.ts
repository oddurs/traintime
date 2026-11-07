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
