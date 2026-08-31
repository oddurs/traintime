"use client";

import { useEffect, useState } from "react";
import type { NetworkIndex } from "@/lib/network";
import type { LineHealth as Health, TrainTimeClient } from "@/lib/client";
import RouteBullet from "./RouteBullet";

interface Props {
  index: NetworkIndex;
  client: TrainTimeClient;
  onSolo: (route: string) => void;
}

const mins = (s: number | null) => (s === null ? "–" : `${(s / 60).toFixed(1)}`);

/** How often trains actually came, per line, from the recorded arrivals of the last hour. */
export default function LineHealth({ index, client, onSolo }: Props) {
  const [lines, setLines] = useState<Health[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const now = Math.floor(Date.now() / 1000);
        const r = await client.lines(now - 3600, now);
        if (!cancelled) setLines(r.lines.filter((l) => l.arrivals >= 10 && index.net.routes[l.route]));
      } catch { if (!cancelled) setLines(null); }
    };
    load();
    const id = setInterval(load, 120_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [client, index]);

  if (!lines?.length) return null;

  return (
    <div className="health">
      <table>
        <thead>
          <tr><th>line</th><th>every</th><th className="wide">vs usual</th><th>dwell</th></tr>
        </thead>
        <tbody>
          {lines.slice(0, 12).map((l) => (
            <tr key={l.route} onClick={() => onSolo(l.route)} title={`${l.arrivals} arrivals in the last hour — click to isolate`}>
              <td><RouteBullet index={index} route={l.route} size={18} /></td>
              <td className="num">{mins(l.headwayP50)}<em>min</em></td>
              <td className="wide">
                {l.headwayRatio === null ? (
                  <span className="muted small">no baseline yet</span>
                ) : (
                  <>
                    <span className="gapbar">
                      <i className={l.headwayRatio > 1.25 ? "worse" : undefined}
                         style={{ width: `${Math.min(100, (l.headwayRatio / 2) * 100)}%` }} />
                    </span>
                    <span className={`num ${l.headwayRatio > 1.25 ? "worse" : ""}`}>
                      {l.headwayRatio > 1.1 ? `${Math.round((l.headwayRatio - 1) * 100)}% worse` : l.headwayRatio < 0.9 ? "better" : "normal"}
                    </span>
                  </>
                )}
              </td>
              <td className="num">{l.dwellP50 === null ? "–" : `${l.dwellP50}s`}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">
        Median time between trains at the same platform over the last hour, against what this line
        normally does at this time of week. Dwell is only reported on the numbered lines and the L.
      </p>
    </div>
  );
}
