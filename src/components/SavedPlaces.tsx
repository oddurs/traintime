"use client";

import { useLayoutEffect, useMemo, useRef } from "react";
import { PHONE_QUERY, SAVED_HEIGHT_KEY } from "@/lib/firstPaint";
import type { Selection, TrainState } from "@/lib/types";
import type { NetworkIndex } from "@/lib/network";
import type { SavedPlace } from "@/lib/places";
import { arrivalsAt } from "@/lib/arrivals";
import { List, Row, Section } from "./ui";
import { Countdown, RouteBullet } from "./brand";

interface Props {
  /**
   * Null while the network is still arriving. The names are stored with the places, so the rows
   * are drawn at once, in their final size, and only the next train fills in.
   */
  index: NetworkIndex | null;
  places: SavedPlace[];
  trains: TrainState[];
  now: number;
  /** No trains yet because none have arrived, rather than because none are coming. */
  waiting: boolean;
  onSelect: (s: Selection) => void;
}

/** How many saved stations fit before the list stops being a glance. */
const MAX_ROWS = 5;
/** Close enough that a number would be a lie. */
const HERE_S = 30;

/** The stations someone saved, each with the next train in the direction they usually take. */
export default function SavedPlaces({ index, places, trains, now, waiting, onSelect }: Props) {
  const rows = useMemo(
    () =>
      places.slice(0, MAX_ROWS).map((p) => {
        const groups = index ? arrivalsAt(index, trains, p.id, 2) : [];
        const preferred = p.direction ? groups.find((g) => g.direction === p.direction) : undefined;
        return { place: p, group: preferred ?? groups[0] };
      }),
    [places, index, trains],
  );
  // Remember how tall this was, so the next visit's first paint can hold the space (firstPaint.ts).
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const h = ref.current?.offsetHeight;
    if (!h) return;
    try {
      const all = JSON.parse(localStorage.getItem(SAVED_HEIGHT_KEY) ?? "{}") as Record<string, number>;
      const layout = matchMedia(PHONE_QUERY).matches ? "phone" : "wide";
      if (all[layout] !== h) localStorage.setItem(SAVED_HEIGHT_KEY, JSON.stringify({ ...all, [layout]: h }));
    } catch { /* storage refused: the next first paint simply does not reserve the space */ }
  });
  if (rows.length === 0) return null;

  return (
    <div ref={ref}>
    <Section title="Saved" ariaLabel="Saved stations">
      <List leading>
        {rows.map(({ place, group }) => {
          const next = group?.arrivals[0];
          const secs = next ? next.eta - now : null;
          const here = !!next?.atPlatform || (secs !== null && secs < HERE_S);
          return (
            <Row
              key={place.id}
              leading={next ? <RouteBullet index={index} route={next.route} size="lg" /> : <span className="roundel-blank" />}
              title={place.name}
              subtitle={next && index ? index.stationName(next.destination) : waiting ? <span className="skel-text" /> : "no trains approaching"}
              trailing={next ? <Countdown seconds={secs!} here={here} /> : undefined}
              onClick={() => onSelect({ kind: "station", id: place.id })}
              ariaLabel={`${place.name} arrivals`}
            />
          );
        })}
      </List>
    </Section>
    </div>
  );
}
