import type { Direction, TrainState } from "./types";
import type { NetworkIndex } from "./network";
import { parentOf } from "./network";

const NY = "America/New_York";

/**
 * "now", "1 min", "12 min" — how long until something happens, in the one unit a rider counts in.
 *
 * This used to switch between seconds and tenths of a minute ("35 s", "2.4 min"), so a list of
 * stops mixed two units and a precision the prediction does not have: a train due in 2.4 minutes
 * is due in two or three, depending on the signals.
 */
export function fmtWhen(secs: number): string {
  if (secs < 30) return "now";
  return `${Math.max(1, Math.round(secs / 60))} min`;
}

/**
 * The uncertainty worth saying out loud, or nothing. Under a minute it does not change what a
 * rider does, and printing "give or take 32 s" on every row made a board of answers read like a
 * table of caveats.
 */
export function fmtSpread(sigma: number): string | null {
  return sigma >= 60 ? `± ${Math.round(sigma / 60)} min` : null;
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

/** Minutes, for a duration a rider reads at a glance. */
const mins = (s: number) => `${Math.max(1, Math.round(s / 60))} min`;

/**
 * What a train is doing, in a sentence — for every status but the two that need no explaining,
 * running and at a platform. See TrainStatus for where each one comes from.
 */
export function statusLine(index: NetworkIndex, st: TrainState, byId: Map<string, TrainState>, now: number): string | null {
  const name = (id: string) => index.stationName(id);
  switch (st.status) {
    case "held": {
      const leader = st.leaderId ? byId.get(st.leaderId) : undefined;
      const behind = leader ? `, behind the ${leader.route}` : "";
      const late = mins(st.heldFor ?? 0);
      return st.phase === "dwelling"
        ? `Held at ${name(st.nextStop)} — ${late} past its departure${behind}`
        : `Held between ${name(st.prevStop ?? st.nextStop)} and ${name(st.nextStop)} — ${late} longer than this usually takes${behind}`;
    }
    case "preparing":
      return `Preparing for its trip — leaves ${name(st.nextStop)} at ${fmtClock(st.startsAt ?? st.eta)}`;
    case "scheduled":
      return st.assigned ? "Scheduled — no train reported for this trip yet" : "Scheduled — no train assigned to this trip yet";
    case "lost":
      return `Lost — the feed still lists it, but nothing about it has changed in ${mins(now - (st.updatedAt ?? now))}`;
    default:
      return null;
  }
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
