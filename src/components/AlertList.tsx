"use client";

import { useState } from "react";
import type { Alert } from "@/lib/alerts";
import type { NetworkIndex } from "@/lib/network";
import { splitBullets } from "@/lib/format";
import { Button, Disclosure, List, Row } from "./ui";
import { RouteBullet } from "./brand";

interface Props {
  index: NetworkIndex;
  alerts: Alert[];
  limit?: number;
  /**
   * Show a single line that opens, rather than the alerts themselves.
   *
   * On a station board the countdown is the whole answer, and two reroute cards above it pushed
   * every train time off a phone screen — you opened a station and could not see a single train.
   * A banner that says how many there are keeps the warning in front of you and costs one row.
   */
  collapsed?: boolean;
}

function AlertText({ index, text }: { index: NetworkIndex; text: string }) {
  return (
    <>
      {splitBullets(text).map((part, i) =>
        part.bullet ? (
          index.net.routes[part.bullet]
            ? <RouteBullet key={i} index={index} route={part.bullet} size="sm" />
            : <b key={i}>{part.bullet}</b>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  );
}

/** MTA service alerts, worst first, with the route bullets in their text rendered properly. */
export default function AlertList({ index, alerts, limit = 4, collapsed = false }: Props) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState(false);
  if (alerts.length === 0) return null;
  if (collapsed && !open) {
    const worst = alerts.some((a) => a.category === "delay") ? "delay"
      : alerts.some((a) => a.category === "planned") ? "planned" : "info";
    return (
      <List>
        <Row
          leading={<span className={`notice-pip pip--${worst}`} aria-hidden="true" />}
          title={alerts.length === 1 ? "1 service change" : `${alerts.length} service changes`}
          disclosure
          onClick={() => setOpen(true)}
        />
      </List>
    );
  }
  const shown = showAll ? alerts : alerts.slice(0, limit);
  return (
    <div className="alerts">
      {shown.map((a) => (
        <Disclosure
          key={a.id}
          tone={a.category}
          lead={a.type}
          summary={<AlertText index={index} text={a.header} />}
          open={expanded === a.id}
          onToggle={() => setExpanded(expanded === a.id ? null : a.id)}
        >
          {a.description && <AlertText index={index} text={a.description} />}
        </Disclosure>
      ))}
      {alerts.length > limit && (
        <span><Button variant="ghost" onClick={() => setShowAll((s) => !s)}>{showAll ? "show fewer" : `${alerts.length - limit} more`}</Button></span>
      )}
      {collapsed && <span><Button variant="ghost" onClick={() => setOpen(false)}>hide service changes</Button></span>}
    </div>
  );
}
