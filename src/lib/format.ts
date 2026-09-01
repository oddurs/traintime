import type { Direction, TrainPosition, TrainState } from "./types";
import type { NetworkIndex } from "./network";
import { parentOf } from "./network";

const NY = "America/New_York";

/** "now", "40 s", "3.2 min" — a countdown a person can read at a glance. */
export function fmtIn(secs: number): string {
  if (secs < 20) return "now";
  if (secs < 60) return `${Math.round(secs / 5) * 5} s`;
  const m = secs / 60;
  return `${m < 10 ? m.toFixed(1) : Math.round(m)} min`;
}

/** Compact countdown for dense lists: "now", "1", "12" (minutes). */
export function fmtMin(secs: number): string {
  if (secs < 30) return "now";
  return String(Math.max(1, Math.round(secs / 60)));
}

export function fmtClock(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString("en-US", { timeZone: NY, hour: "numeric", minute: "2-digit" });
}

export function fmtClockSec(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString("en-US", { timeZone: NY, hour: "numeric", minute: "2-digit", second: "2-digit" });
}

export function fmtAgo(secs: number): string {
  if (secs < 5) return "just now";
  if (secs < 90) return `${Math.round(secs)} s ago`;
  const m = secs / 60;
  return m < 60 ? `${Math.round(m)} min ago` : `${(m / 60).toFixed(1)} h ago`;
}

export function directionLabel(d: Direction): string {
  return d === "N" ? "Northbound" : "Southbound";
}

export function kmh(mps: number): number {
  return Math.round(mps * 3.6);
}

/**
 * Plain-language account of how we know where this train is. The map's honesty depends on
 * this being specific: what was reported, what was modelled, and how stale it is.
 */
export function provenance(index: NetworkIndex, st: TrainState, now: number): { line: string; confident: boolean } {
  const prev = st.prevStop ? index.stationName(st.prevStop) : null;
  if (st.phase === "dwelling") {
    const ago = now - (st.arrivedAt ?? now);
    return { line: `Confirmed at ${index.stationName(st.nextStop)} ${fmtAgo(ago)}`, confident: true };
  }
  if (st.phase === "unstarted") {
    return { line: `Not in service yet — scheduled to leave ${index.stationName(st.nextStop)}`, confident: false };
  }
  if (!prev) return { line: "Position estimated from the arrival prediction alone", confident: false };
  if (st.prevInferred) {
    return { line: `First seen mid-run; assumed to have left ${prev}`, confident: false };
  }
  if (st.departedEstimated) {
    return { line: `Left ${prev} — departure modelled (this line doesn't report departures)`, confident: false };
  }
  const ago = st.departedAt !== undefined ? now - st.departedAt : undefined;
  return { line: `Left ${prev}${ago !== undefined ? ` ${fmtAgo(ago)}` : ""} — reported`, confident: true };
}

/** How our arrival estimate differs from the MTA's raw prediction, in words. */
export function etaProvenance(eta: number, etaRaw: number, sigma: number): string {
  const drift = Math.round(etaRaw - eta);
  const spread = `±${Math.round(sigma)} s`;
  if (Math.abs(drift) < 8) return `${spread} · agrees with the MTA`;
  return `${spread} · MTA is usually ${Math.abs(drift)} s ${drift > 0 ? "late" : "early"} here`;
}

/** Why a train is not moving, when it isn't at a platform. */
/** Long enough that "stopped" is the honest word, rather than a pause between signals. */
export const STALLED_S = 120;

/** Minutes, for a duration a rider reads at a glance. */
const mins = (s: number) => `${Math.max(1, Math.round(s / 60))} min`;

export function holdReason(index: NetworkIndex, t: TrainPosition, byId: Map<string, TrainState>): string | null {
  // A train that has not moved for minutes is stopped, whatever the reason, and saying so comes
  // before naming a cause we may not know.
  if (t.stalledFor >= STALLED_S) {
    const leader = t.state.leaderId ? byId.get(t.state.leaderId) : undefined;
    const behind = leader ? ` behind the ${leader.route}` : "";
    return `Stopped for ${mins(t.stalledFor)}${behind}, between ${index.stationName(t.state.prevStop ?? t.state.nextStop)} and ${index.stationName(t.state.nextStop)}`;
  }
  if (t.motion !== "holding") return null;
  const leader = t.state.leaderId ? byId.get(t.state.leaderId) : undefined;
  if (leader) {
    const where = leader.phase === "dwelling" ? `at ${index.stationName(leader.nextStop)}` : "ahead on this track";
    return `Holding behind the ${leader.route} ${where}`;
  }
  return "Holding — the arrival estimate moved later";
}

/** Split MTA alert text on its [A][C] route bullets so the UI can render real bullets. */
export function splitBullets(text: string): { text: string; bullet?: string }[] {
  const out: { text: string; bullet?: string }[] = [];
  const re = /\[([A-Z0-9]{1,3})\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    out.push({ text: "", bullet: m[1] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

export { parentOf };
