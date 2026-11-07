"use client";

import type { Selection } from "@/lib/types";
import type { NetworkIndex } from "@/lib/network";
import type { GeoStatus } from "@/lib/geolocation";
import { RADII_MIN, type NearbyStation, type RadiusMin } from "@/lib/nearby";
import { directionLabel } from "@/lib/format";
import { Icon, List, Row, Section, Segmented, Stack, Text } from "./ui";
import { BulletGroup, Countdown, RouteBullet } from "./brand";

interface Props {
  index: NetworkIndex | null;
  /** Null until a position is known. */
  stations: NearbyStation[] | null;
  geo: GeoStatus;
  /** Whether the rider has asked to be located. */
  on: boolean;
  onLocate: () => void;
  radius: RadiusMin;
  onRadius: (r: RadiusMin) => void;
  now: number;
  waiting: boolean;
  onSelect: (s: Selection) => void;
}

/** Close enough that a number would be a lie. */
const HERE_S = 30;

const RADIUS_OPTIONS = RADII_MIN.map((m) => ({ value: m, label: `${m} min` }));

const distance = (m: number) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);

/**
 * What is arriving within a short walk of you.
 *
 * "Near me" used to open the single nearest station's board and follow you from one to the next.
 * That answers "where is the closest platform", which is rarely the question: two stations five
 * minutes apart serve different lines, and the useful answer is every train you could reach, in
 * the order you would walk to them. Each station is one small group — its name and how far, then
 * its next few trains — and a countdown is dimmed when the walk is longer than the wait.
 */
export default function Nearby({ index, stations, geo, on, onLocate, radius, onRadius, now, waiting, onSelect }: Props) {
  const located = on && stations !== null;
  const accessory = located
    ? <Segmented ariaLabel="Walking distance" value={radius} options={RADIUS_OPTIONS} onChange={onRadius} />
    : undefined;

  if (!located) {
    const [title, subtitle] =
      geo === "denied" ? ["Location is off", "Allow location for this site to see trains near you"]
      : geo === "unavailable" ? ["Location isn’t available", "This browser couldn’t find where you are"]
      : on ? ["Finding you…", "Looking for stations within a short walk"]
      : ["Trains near you", "See what’s arriving within a short walk"];
    return (
      <Section title="Nearby">
        <List leading>
          <Row
            leading={<span className="row-glyph"><Icon name="location.fill" /></span>}
            title={title} subtitle={subtitle}
            disclosure={!on || geo === "denied" || geo === "unavailable"}
            onClick={onLocate}
            ariaLabel={on ? title : "Use my location to show trains near me"}
          />
        </List>
      </Section>
    );
  }

  return (
    <Section title="Nearby" accessory={accessory} ariaLabel="Trains near you">
      {stations.length === 0 && (
        <List>
          <li className="list-static">
            <Text variant="subhead" tone="secondary">
              No stations within a {radius}-minute walk.{radius < RADII_MIN[RADII_MIN.length - 1] ? " Try a wider radius." : ""}
            </Text>
          </li>
        </List>
      )}
      <Stack gap={3}>
        {stations.map((s) => (
          <List leading key={s.id} ariaLabel={`${s.name}, ${Math.max(1, Math.round(s.walkSeconds / 60))} minute walk`}>
            <Row
              leading={<span className="row-glyph"><Icon name="location" /></span>}
              title={s.name}
              subtitle={`${Math.max(1, Math.round(s.walkSeconds / 60))} min walk · ${distance(s.meters)}`}
              trailing={index ? <BulletGroup index={index} routes={s.routes} size="sm" limit={5} /> : undefined}
              onClick={() => onSelect({ kind: "station", id: s.id })}
              ariaLabel={`${s.name} arrivals`}
            />
            {s.arrivals.length === 0 && (
              <li className="list-static">
                <Text variant="subhead" tone="secondary">{waiting ? "Waiting for live trains…" : "No trains approaching right now."}</Text>
              </li>
            )}
            {index && s.arrivals.map((a) => {
              const secs = a.eta - now;
              const here = a.atPlatform || secs < HERE_S;
              return (
                <Row
                  key={a.id}
                  leading={<RouteBullet index={index} route={a.route} size="lg" />}
                  title={index.stationName(a.destination)}
                  subtitle={a.atPlatform ? "at the platform"
                    : secs < s.walkSeconds ? "too soon to reach on foot"
                    : `${directionLabel(a.direction)} · ${a.stopsAway === 0 ? "next stop" : `${a.stopsAway} stop${a.stopsAway > 1 ? "s" : ""} away`}`}
                  trailing={<Countdown seconds={secs} here={here} departing={a.departing} missed={secs < s.walkSeconds} compact />}
                  onClick={() => onSelect({ kind: "train", id: a.id })}
                  title_="Show this train on the map"
                  ariaLabel={`${a.route} train to ${index.stationName(a.destination)} at ${s.name}, ${here ? "now" : `in ${Math.max(1, Math.round(secs / 60))} minutes`}`}
                />
              );
            })}
          </List>
        ))}
      </Stack>
    </Section>
  );
}
