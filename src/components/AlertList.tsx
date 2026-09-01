"use client";

import { useState } from "react";
import type { Alert } from "@/lib/alerts";
import type { NetworkIndex } from "@/lib/network";
import { splitBullets } from "@/lib/format";
import RouteBullet from "./RouteBullet";

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

function Text({ index, text }: { index: NetworkIndex; text: string }) {
  return (
    <>
      {splitBullets(text).map((part, i) =>
        part.bullet ? (
          index.net.routes[part.bullet]
            ? <RouteBullet key={i} index={index} route={part.bullet} size={15} />
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
      <button className={`alert-summary ${worst}`} onClick={() => setOpen(true)} aria-expanded={false}>
        <span className="pip" />
        <span>{alerts.length === 1 ? "1 service change" : `${alerts.length} service changes`}</span>
        <span className="chev" aria-hidden="true">›</span>
      </button>
    );
  }
  const shown = showAll ? alerts : alerts.slice(0, limit);
  return (
    <div className="alerts">
      {shown.map((a) => (
        <div key={a.id} className={`alert ${a.category}`}>
          <button className="alert-head" onClick={() => setExpanded(expanded === a.id ? null : a.id)} aria-expanded={expanded === a.id}>
            <span className="alert-type">{a.type}</span>
            <span className="alert-text"><Text index={index} text={a.header} /></span>
          </button>
          {expanded === a.id && a.description && (
            <div className="alert-body"><Text index={index} text={a.description} /></div>
          )}
        </div>
      ))}
      {alerts.length > limit && (
        <button className="alerts-more" onClick={() => setShowAll((s) => !s)}>
          {showAll ? "show fewer" : `${alerts.length - limit} more`}
        </button>
      )}
      {collapsed && <button className="alerts-more" onClick={() => setOpen(false)}>hide service changes</button>}
    </div>
  );
}
