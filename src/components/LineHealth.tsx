"use client";

import { useEffect, useState } from "react";
import type { NetworkIndex } from "@/lib/network";
import type { LineHealth as Health, BoundClient } from "@/lib/client";
import { Meter } from "./ui";
import { RouteBullet } from "./brand";

const mins = (s: number | null) => (s === null ? "–" : `${(s / 60).toFixed(1)}`);

/** Headway this much above the line's own normal is worth colouring. */
export const WORSE = 1.25;
/** Below this the difference is noise, and the honest word is "normal". */
const NOTABLE = 1.1;
/** The meter runs to twice normal, so "normal" sits at its midpoint. */
const METER_FULL = 2;
/** Fewer arrivals than this in the hour and the median is one or two trains, not a headway. */
const MIN_ARRIVALS = 10;
const EVERY_MS = 120_000;

/**
 * How often trains actually came, per line, from the recorded arrivals of the last hour.
 *
 * A hook of its own because two things read it: the figures at the head of the Lines group, which
 * are always on screen, and the table inside it, which is only drawn when the group is open.
 */
export function useLineHealth(client: BoundClient, index: NetworkIndex | null, enabled: boolean): Health[] | null {
  const [lines, setLines] = useState<Health[] | null>(null);
  useEffect(() => {
    if (!enabled || !index) return;
    let cancelled = false;
    const load = async () => {
      try {
        const now = Math.floor(Date.now() / 1000);
        const r = await client.lines(now - 3600, now);
        if (!cancelled) setLines(r.lines.filter((l) => l.arrivals >= MIN_ARRIVALS && index.net.routes[l.route]));
      } catch (e) {
        // The figures are extra: without them the group still says what is running and what is
        // held. Say why in the console, and keep whatever the last good answer was.
        console.warn("line health:", e);
      }
    };
    load();
    const id = setInterval(load, EVERY_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [client, index, enabled]);
  return lines;
}

interface Props {
  index: NetworkIndex;
  lines: Health[];
  onSolo: (route: string) => void;
}

/** The table: one line per service, worst first, with its headway against its own normal. */
export default function LineHealth({ index, lines, onSolo }: Props) {
  if (!lines.length) return null;
  const worstFirst = [...lines].sort((a, b) => (b.headwayRatio ?? 0) - (a.headwayRatio ?? 0));

  return (
    <div className="health">
      <table>
        <thead>
          <tr><th>line</th><th>every</th><th className="wide">vs usual</th><th>dwell</th></tr>
        </thead>
        <tbody>
          {worstFirst.slice(0, 12).map((l) => (
            <tr key={l.route} onClick={() => onSolo(l.route)} title={`${l.arrivals} arrivals in the last hour — click to isolate`}>
              <td><RouteBullet index={index} route={l.route} size="md" /></td>
              <td className="num">{mins(l.headwayP50)}<em>min</em></td>
              <td className="wide">
                {l.headwayRatio === null ? (
                  <span className="muted hint">no baseline yet</span>
                ) : (
                  <>
                    <Meter value={l.headwayRatio / METER_FULL} tone={l.headwayRatio > WORSE ? "bad" : "warn"} />
                    <span className={`num ${l.headwayRatio > WORSE ? "worse" : ""}`}>
                      {l.headwayRatio > NOTABLE ? `${Math.round((l.headwayRatio - 1) * 100)}% worse` : l.headwayRatio < 0.9 ? "better" : "normal"}
                    </span>
                  </>
                )}
              </td>
              <td className="num">{l.dwellP50 === null ? "–" : `${l.dwellP50}s`}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted hint">
        Median time between trains at the same platform over the last hour, against what this line
        normally does at this time of week. Dwell is only reported on the numbered lines and the L.
      </p>
    </div>
  );
}
