"use client";

import { useMemo, useState } from "react";
import type { TrainState } from "@/lib/types";
import type { NetworkIndex } from "@/lib/network";
import type { AlertIndex } from "@/lib/alerts";
import { routeStatus } from "@/lib/alerts";
import type { LineHealth as Health, BoundClient } from "@/lib/client";
import type { StreamMode } from "@/lib/useTrainStream";
import { TRUNKS } from "@/lib/trunks";
import { Button, Inline, List, Row, Section, Stack, Switch, Text } from "./ui";
import { RouteBullet } from "./brand";
import LineHealth, { WORSE } from "./LineHealth";
import Legend from "./Legend";
import Timeline from "./Timeline";

/*
 * The services, grouped the way the map is: by trunk line. There is one description of how the
 * network is organised, in the trunk table, and this reads it.
 */
const GROUPS: string[][] = Object.values(TRUNKS).map((t) => t.services);

interface Props {
  index: NetworkIndex | null;
  trains: TrainState[];
  alerts: AlertIndex | null;
  /** Headways from the poller's history, when there is a poller to ask. */
  health: Health[] | null;
  visible: Set<string> | null;
  onToggle: (route: string, solo: boolean) => void;
  onAll: (on: boolean) => void;
  showRibbons: boolean;
  onRibbons: (on: boolean) => void;
  /** The replay timeline needs the poller's history; without it the group leaves it out. */
  client?: BoundClient;
  mode: StreamMode;
  onMode: (m: StreamMode) => void;
  now: number;
  live: boolean;
}

/**
 * How the railway is doing, then the switches for what the map shows.
 *
 * The twenty-five toggles used to be the first thing under the search field, always open: a wall
 * of bullets that a rider looking for their train had to scroll past, and that said nothing about
 * service. The group now leads with four figures — running, held, slower than usual, delayed — and
 * keeps the toggles one row down, closed, with the headway table and the map key beside them.
 */
export default function LinesCard(props: Props) {
  const { index, trains, alerts, health, visible, onToggle, onAll, showRibbons, onRibbons, client, mode, onMode, now, live } = props;
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState(false);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const t of trains) c[t.route] = (c[t.route] ?? 0) + 1;
    return c;
  }, [trains]);
  // In service: on the move or at a platform. A trip with no train yet is not a train running.
  const running = useMemo(() => trains.filter((t) => t.status === "running" || t.status === "at-platform" || t.status === "held").length, [trains]);
  const held = useMemo(() => trains.filter((t) => t.status === "held").length, [trains]);
  const routes = useMemo(() => (index ? Object.keys(index.net.routes) : []), [index]);
  const delayed = useMemo(() => routes.filter((r) => routeStatus(alerts, r)?.category === "delay").length, [routes, alerts]);
  const slow = health ? health.filter((l) => (l.headwayRatio ?? 0) > WORSE).length : null;
  const hidden = visible && routes.length ? routes.length - visible.size : 0;

  return (
    <Section title="Lines">
      <List>
        <li className="list-static" aria-label="Service right now: trains running, trains held, lines slower than usual, lines with delays">
          <div className="stats">
            <Stat value={trains.length ? running : "–"} label="trains" />
            <Stat value={trains.length ? held : "–"} label="held" tone={held ? "warn" : undefined} />
            {slow !== null && <Stat value={slow} label="slow lines" tone={slow ? "warn" : undefined} />}
            <Stat value={alerts ? delayed : "–"} label="delayed" tone={delayed ? "bad" : undefined} />
          </div>
        </li>
        <Row
          title="Lines on the map"
          subtitle={hidden ? `${routes.length - hidden} of ${routes.length} shown` : "All shown"}
          expanded={open}
          onClick={() => setOpen((o) => !o)}
        />
      </List>

      {open && (
        <Stack gap={4}>
          <div className="routes" role="group" aria-label="Show or hide lines">
            {GROUPS.map((group, gi) => (
              <div className="group" key={gi}>
                {group.filter((id) => !index || index.net.routes[id]).map((id) => {
                  const on = !visible || visible.has(id);
                  const alert = routeStatus(alerts, id);
                  return (
                    <span className={`route-toggle${on ? "" : " is-off"}`} key={id}>
                      <RouteBullet
                        index={index} route={id} size="lg" dim={!on}
                        title={`${index?.net.routes[id].name ?? id}${counts[id] ? ` · ${counts[id]} running` : ""}${alert ? ` · ${alert.count} service alert${alert.count > 1 ? "s" : ""}` : ""} — tap to show or hide, shift-click to show only this line`}
                        onClick={index ? (e) => onToggle(id, e.shiftKey) : undefined}
                      >
                        {alert && <span className={`alert-pip ${alert.category}`} />}
                      </RouteBullet>
                      <em>{counts[id] || ""}</em>
                    </span>
                  );
                })}
              </div>
            ))}
          </div>

          <Inline justify="between" wrap>
            <Inline gap={2}>
              <Button onClick={() => onAll(true)}>Show all</Button>
              <Button onClick={() => onAll(false)}>Hide all</Button>
            </Inline>
            <Switch checked={showRibbons} onChange={onRibbons}>Uncertainty</Switch>
          </Inline>

          {index && health && health.length > 0 && (
            <Section title="How often trains are coming">
              <LineHealth index={index} lines={health} onSolo={(r) => onToggle(r, true)} />
            </Section>
          )}

          {client && (
            <Section
              title="History"
              accessory={<Button variant="ghost" on={history} onClick={() => setHistory((h) => !h)} ariaExpanded={history}>{history ? "Hide" : "Replay"}</Button>}
            >
              {history && <Timeline client={client} mode={mode} onMode={onMode} now={now} live={live} />}
            </Section>
          )}

          <Section title="Map key">
            <Legend />
          </Section>
        </Stack>
      )}
    </Section>
  );
}

/** One figure and what it counts. The figure is read first, so it is the larger of the two. */
function Stat({ value, label, tone }: { value: React.ReactNode; label: string; tone?: "warn" | "bad" }) {
  return (
    <Stack gap={0}>
      <Text variant="figure" tone={tone}>{value}</Text>
      <Text variant="footnote" tone="tertiary" truncate>{label}</Text>
    </Stack>
  );
}
