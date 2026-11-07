"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * The stations someone has looked at lately, newest first — what Maps shows under its search field
 * before a word is typed. Saved stations are the ones a rider chose to keep; these are the ones
 * they keep coming back to without having said so.
 */
export interface Recent {
  id: string;
  name: string;
  at: number;
}

const KEY = "tt.recents.v1";
/** Enough to cover a week of someone's own stations, few enough to read at a glance. */
export const MAX_RECENTS = 6;

/** The list with `id` moved to the front, or added there, and the oldest dropped past the limit. */
export function remember(list: Recent[], id: string, name: string, at: number): Recent[] {
  return [{ id, name, at }, ...list.filter((r) => r.id !== id)].slice(0, MAX_RECENTS);
}

function read(): Recent[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? "[]") as Recent[];
    return Array.isArray(parsed) ? parsed.filter((r) => r && typeof r.id === "string" && typeof r.name === "string") : [];
  } catch {
    return [];
  }
}

function write(list: Recent[]) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* storage refused: recents last for this visit only */ }
}

export function useRecents() {
  const [recents, setRecents] = useState<Recent[]>([]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time read of a store render cannot touch
    setRecents(read());
  }, []);
  const add = useCallback((id: string, name: string) => {
    setRecents((cur) => {
      const next = remember(cur, id, name, Date.now() / 1000);
      write(next);
      return next;
    });
  }, []);
  const clear = useCallback(() => { setRecents([]); write([]); }, []);
  return { recents, add, clear };
}
