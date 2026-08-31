"use client";

import { useMemo } from "react";
import type { Selection, TrainState } from "@/lib/types";
import type { NetworkIndex } from "@/lib/network";
import type { SavedPlace } from "@/lib/places";
import { arrivalsAt } from "@/lib/arrivals";
import { fmtMin } from "@/lib/format";
import RouteBullet from "./RouteBullet";

interface Props {
  index: NetworkIndex;
  places: SavedPlace[];
  trains: TrainState[];
  now: number;
  onSelect: (s: Selection) => void;
}

/** The stations someone saved, each with the next train in the direction they usually take. */
export default function SavedPlaces({ index, places, trains, now, onSelect }: Props) {
  const rows = useMemo(
    () =>
      places.slice(0, 5).map((p) => {
        const groups = arrivalsAt(index, trains, p.id, 2);
        const preferred = p.direction ? groups.find((g) => g.direction === p.direction) : undefined;
        return { place: p, group: preferred ?? groups[0] };
      }),
    [places, index, trains],
  );
  if (rows.length === 0) return null;

  return (
    <section aria-label="Saved stations">
      <h3 className="section-title">Saved</h3>
      <ul className="arrivals">
        {rows.map(({ place, group }) => {
          const next = group?.arrivals[0];
          const secs = next ? next.eta - now : null;
          const here = next?.atPlatform || (secs !== null && secs < 30);
          return (
            <li key={place.id}>
              <button onClick={() => onSelect({ kind: "station", id: place.id })} aria-label={`${place.name} arrivals`}>
                {next ? <RouteBullet index={index} route={next.route} size={26} /> : <span className="roundel-blank" />}
                <span className="arr-dest">
                  <b>{place.name}</b>
                  <em>{next ? `${index.stationName(next.destination)}` : "no trains approaching"}</em>
                </span>
                {next && (
                  <span className={`arr-eta ${here ? "here" : ""}`}>
                    <b>{here ? "now" : fmtMin(secs!)}</b>
                    {!here && <i>min</i>}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
