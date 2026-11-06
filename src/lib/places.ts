"use client";

import { useCallback, useEffect, useState } from "react";
import { PLACES_KEY } from "./firstPaint";

/**
 * The stations someone actually uses. A commuter takes the same two or three trains every day,
 * so remembering them — and which way they were heading — turns a general-purpose map into
 * something that answers their question before they ask it.
 */
export interface SavedPlace {
  id: string;
  name: string;
  addedAt: number;
  lastUsedAt: number;
  /** Which way they last looked from here; the morning and evening answers differ. */
  direction?: "N" | "S";
}

// Read before React runs as well, by the first-paint script, so the name lives with it.
const KEY = PLACES_KEY;

function read(): SavedPlace[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as SavedPlace[];
    return Array.isArray(parsed) ? parsed.filter((p) => p && typeof p.id === "string") : [];
  } catch {
    return [];
  }
}

function write(places: SavedPlace[]) {
  try { localStorage.setItem(KEY, JSON.stringify(places.slice(0, 12))); } catch {}
}

export function usePlaces() {
  const [places, setPlaces] = useState<SavedPlace[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const stored = read();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time read of a store render cannot touch
    setPlaces(stored);
    setLoaded(true);
  }, []);

  const save = useCallback((next: SavedPlace[]) => {
    setPlaces(next);
    write(next);
  }, []);

  const toggle = useCallback((id: string, name: string) => {
    setPlaces((cur) => {
      const exists = cur.some((p) => p.id === id);
      const next = exists
        ? cur.filter((p) => p.id !== id)
        : [{ id, name, addedAt: Date.now() / 1000, lastUsedAt: Date.now() / 1000 }, ...cur];
      write(next);
      return next;
    });
  }, []);

  /** Record that a station was looked at, and which way — this is what makes it feel personal. */
  const touch = useCallback((id: string, direction?: "N" | "S") => {
    setPlaces((cur) => {
      if (!cur.some((p) => p.id === id)) return cur;
      const next = cur.map((p) => (p.id === id ? { ...p, lastUsedAt: Date.now() / 1000, direction: direction ?? p.direction } : p));
      write(next);
      return next;
    });
  }, []);

  const isSaved = useCallback((id: string) => places.some((p) => p.id === id), [places]);

  return { places, loaded, save, toggle, touch, isSaved };
}

/** Comfortable walking pace in metres per second, including stairs and a wait to cross. */
export const WALK_MPS = 1.25;

export function walkSeconds(metres: number): number {
  // Street distance is longer than the straight line, and there is always a staircase.
  return (metres * 1.3) / WALK_MPS + 45;
}
