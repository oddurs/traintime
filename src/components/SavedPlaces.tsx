"use client";

import { useMemo } from "react";
import type { Selection, TrainState } from "@/lib/types";
import type { NetworkIndex } from "@/lib/network";
import type { SavedPlace } from "@/lib/places";
import { arrivalsAt } from "@/lib/arrivals";
import { List, Row, Section } from "./ui";
import RouteBullet from "./RouteBullet";
import Countdown from "./Countdown";

interface Props {
  index: NetworkIndex;
  places: SavedPlace[];
  trains: TrainState[];
  now: number;
  onSelect: (s: Selection) => void;
}

/** How many saved stations fit before the list stops being a glance. */
const MAX_ROWS = 5;
/** Close enough that a number would be a lie. */
const HERE_S = 30;

/** The stations someone saved, each with the next train in the direction they usually take. */
export default function SavedPlaces({ index, places, trains, now, onSelect }: Props) {
  const rows = useMemo(
    () =>
      places.slice(0, MAX_ROWS).map((p) => {
        const groups = arrivalsAt(index, trains, p.id, 2);
        const preferred = p.direction ? groups.find((g) => g.direction === p.direction) : undefined;
        return { place: p, group: preferred ?? groups[0] };
      }),
    [places, index, trains],
  );
  if (rows.length === 0) return null;

  return (
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
              subtitle={next ? index.stationName(next.destination) : "no trains approaching"}
              trailing={next ? <Countdown seconds={secs!} here={here} /> : undefined}
              onClick={() => onSelect({ kind: "station", id: place.id })}
              ariaLabel={`${place.name} arrivals`}
            />
          );
        })}
      </List>
    </Section>
  );
}
