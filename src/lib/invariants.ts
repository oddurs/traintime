/**
 * What must be true of the trains we are drawing.
 *
 * One definition, used by the live audit, the replay audit and the poller's own `/health`, so the
 * three cannot drift apart. Each rule came out of a defect found by auditing the running app.
 */
import type { TrainState } from "./types";
import { NetworkIndex, parentOf } from "./network";


export type Severity = "high" | "medium" | "low";

export interface Violation {
  severity: Severity;
  rule: string;
  detail: string;
  count: number;
}

/** Beyond any real layover: a train parked longer than this is not running. */
const MAX_DWELL_S = 1800;
/** A moving train whose arrival is this far in the past has been lost, not delayed. */
const MAX_OVERDUE_S = 600;

export function checkInvariants(net: NetworkIndex, states: TrainState[], now: number): Violation[] {
  const hits = new Map<string, { severity: Severity; examples: string[]; count: number }>();
  const flag = (severity: Severity, rule: string, example: string) => {
    const e = hits.get(rule) ?? { severity, examples: [], count: 0 };
    e.count++;
    if (e.examples.length < 3) e.examples.push(example);
    hits.set(rule, e);
  };
  const known = (id: string) => !!net.station(id);

  for (const t of states) {
    const who = `${t.route} ${t.id.slice(0, 22)}`;
    if (!net.net.routes[t.route]) flag("high", "route not in the schedule", `${t.route} (${t.id.slice(0, 22)})`);
    if (!known(t.nextStop)) flag("high", "next stop not in the schedule", `${who} -> ${t.nextStop}`);
    if (t.destination && !known(t.destination)) flag("medium", "terminal not in the schedule", `${who} -> ${t.destination}`);
    for (const s of t.stops) if (!known(s.id)) flag("medium", "predicted stop not in the schedule", `${who} @ ${s.id}`);

    for (let i = 1; i < t.stops.length; i++) {
      if (t.stops[i].eta < t.stops[i - 1].eta - 1) {
        flag("high", "predicted stop times run backwards", `${who} ${t.stops[i - 1].id}->${t.stops[i].id} by ${Math.round(t.stops[i - 1].eta - t.stops[i].eta)}s`);
        break;
      }
    }

    // A dwelling train's eta is when it arrived, not a forecast, so only a moving one can be overdue.
    if (t.phase === "moving" && t.etaRaw < now - MAX_OVERDUE_S && t.status !== "lost") flag("high", "long overdue and not flagged", `${who} ${Math.round((now - t.etaRaw) / 60)}min`);
    if (t.phase === "dwelling" && t.arrivedAt && now - t.arrivedAt > MAX_DWELL_S && t.status !== "lost") {
      flag("high", "parked beyond any real layover, and not flagged", `${who} ${Math.round((now - t.arrivedAt) / 60)}min`);
    }
    if (t.eta > now + 7200) flag("medium", "arrival predicted absurdly far ahead", `${who} ${Math.round((t.eta - now) / 60)}min`);
    if (t.sigma < 0 || t.sigma > 900) flag("medium", "uncertainty out of range", `${who} sigma ${Math.round(t.sigma)}`);
    if (t.arrivedAt && t.arrivedAt > now + 5) flag("medium", "arrived in the future", who);
    if (t.phase === "moving" && t.prevStop && parentOf(t.prevStop) === parentOf(t.nextStop)) flag("medium", "moving between one stop and itself", who);
    if (t.runTime !== undefined && (t.runTime < 5 || t.runTime > 1800)) flag("low", "implausible run time", `${who} ${Math.round(t.runTime)}s`);
    if (t.status === "lost") flag("low", "train the feed has stopped updating", who);
    if (t.phase === "moving" && t.prevStop) {
      const a = parentOf(t.prevStop), b = parentOf(t.nextStop);
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      if (a !== b && !(net.net.routeSegments[t.route] ?? []).includes(key)) {
        flag("low", "running off its scheduled pattern (reroute, or a gap in the schedule)", `${who} ${net.stationName(a)}->${net.stationName(b)}`);
      }
    }
  }

  // The same physical train must never be drawn twice — the signature of a botched turnaround.
  const byTrain = new Map<string, string[]>();
  for (const t of states) if (t.trainId) (byTrain.get(t.trainId) ?? byTrain.set(t.trainId, []).get(t.trainId)!).push(t.id);
  for (const [id, trips] of byTrain) {
    if (trips.length > 1) flag("high", "one physical train drawn more than once", `${id} as ${trips.map((x) => x.slice(0, 18)).join(" + ")}`);
  }

  const rank: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
  return [...hits.entries()]
    .map(([rule, e]) => ({ severity: e.severity, rule, detail: e.examples.join(" ; "), count: e.count }))
    .sort((a, b) => rank[a.severity] - rank[b.severity] || b.count - a.count);
}

/** High and medium findings are defects; low ones are facts about the feed worth reporting. */
export const isFailure = (v: Violation) => v.severity === "high" || v.severity === "medium";
