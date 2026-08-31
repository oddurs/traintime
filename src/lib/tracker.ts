import type {
  Direction, FeedStatus, FeedTick, StateDelta, StateSnapshot, StopPrediction, TrainState, TrainUpdate, VehicleStatus,
} from "./types";
import { NetworkIndex, parentOf } from "./network";
import { Timing, conditionsAt, type Conditions } from "./timing";

export type EventKind = "arrive" | "depart" | "pass" | "incoming";

export interface StationEvent {
  ts: number;
  feedTs: number;
  tripId: string;
  route: string;
  direction: Direction;
  stopId: string;
  kind: EventKind;
  track?: string;
  /** Timestamp came from our poll clock, not the feed. */
  estimated: boolean;
}

export interface EtaObservation {
  obsTs: number;
  tripId: string;
  route: string;
  direction: Direction;
  stopId: string;
  seq: number;
  predicted: number;
  prevStop?: string;
  departedAt?: number;
}

interface Memory {
  u: TrainUpdate;
  feed: string;
  firstSeen: number;
  lastSeen: number;
  status?: VehicleStatus;
  stopId?: string;
  vehicleTs?: number;
  prevStop?: string;
  departedAt?: number;
  departedEstimated?: boolean;
  arrivedAt?: number;
  /** Arrival time at prevStop, for estimating an unobserved departure. */
  prevArrivedAt?: number;
  /** Times the vehicle timestamp advanced while STOPPED_AT at the current stop. */
  beats: number;
  inferredPrev?: string;
  lastEta: Map<string, number>;
  /**
   * How far off this particular trip's predictions have been running, in seconds, as an
   * exponentially weighted mean. A train that has arrived 40 s late at each of its last few
   * stops is very likely to be 40 s late at the next one, and no amount of per-segment history
   * captures that — it is a property of this run, not of the track.
   */
  bias: number;
  biasN: number;
  /** Our own most recent adjusted arrival time per upcoming stop, to score ourselves against. */
  lastAdjusted: Map<string, number>;
  sig: string;
  changedAt: number;
  dirty: boolean;
}

const EXPIRE_AFTER = 120;
const ETA_OBS_STOPS = 3;
/**
 * The least time that can pass between one train leaving a platform and the next reaching it.
 * Taken from the recorded events rather than guessed: the 5th percentile of observed
 * departure-to-next-arrival at the same platform is 44 s, so 40 s is a floor that almost never
 * contradicts reality while still catching predictions that are physically impossible.
 */
const CLEARANCE_S = 40;
/**
 * When to stop believing in a train. The test is whether it is making progress, not whether its
 * record is changing: a train with a stable prediction and no vehicle updates looks frozen while
 * running perfectly well, and keying on that flagged a quarter of the system as ghosts. What
 * actually gives one away is sitting at a platform beyond any real layover, or being long overdue
 * at a stop it never reached.
 */
const MAX_DWELL_S = 1800;
const MAX_OVERDUE_S = 600;

const nyTime = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false, weekday: "short" });
const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
export function nyHourDow(epochSec: number): { hour: number; dow: number } {
  const parts = nyTime.formatToParts(new Date(epochSec * 1000));
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
  const dow = DOW[parts.find((p) => p.type === "weekday")?.value ?? "Sun"] ?? 0;
  return { hour, dow };
}

/**
 * Keeps every train the feed has ever shown us, detects station events from vehicle status
 * transitions, records ETA revisions, and derives the state the client animates.
 */
export class Tracker {
  private mem = new Map<string, Memory>();
  private lastTickTs = new Map<string, number>();
  /**
   * Per-feed evidence of how vehicle records behave. Transit feeds (numbered lines, L) update the
   * timestamp while IN_TRANSIT_TO, so departures are observed. Heartbeat feeds (lettered lines)
   * stay STOPPED_AT through the whole run while the timestamp — the MTA's own expected-departure
   * estimate — is pushed forward; departures there are unobservable and must be modelled.
   */
  private feedStats = new Map<string, { beats: number; transit: number }>();
  private removed: string[] = [];
  private lastLeader = new Map<string, string | undefined>();
  feeds = new Map<string, FeedStatus>();
  /** Latest feed timestamp seen across feeds. */
  clock = 0;
  /** Stops the feeds referenced that the schedule does not contain, for reporting. */
  readonly unknownStops = new Set<string>();

  constructor(
    private readonly net: NetworkIndex,
    public timing: Timing,
  ) {}

  isHeartbeatFeed(feed: string): boolean {
    const f = this.feedStats.get(feed);
    return !!f && f.beats > f.transit;
  }

  /** Ingest one feed tick. Returns the events and ETA revisions it produced. */
  ingest(tick: FeedTick): { events: StationEvent[]; etaObs: EtaObservation[]; fresh: boolean } {
    const events: StationEvent[] = [];
    const etaObs: EtaObservation[] = [];
    const last = this.lastTickTs.get(tick.feed) ?? 0;
    if (tick.ts <= last) return { events, etaObs, fresh: false };
    this.lastTickTs.set(tick.feed, tick.ts);
    this.clock = Math.max(this.clock, tick.ts);

    for (const u of tick.trains) {
      if (u.stops.length === 0) continue;
      let m = this.mem.get(u.id);
      const v = u.vehicle;
      if (!m) {
        m = {
          u, feed: tick.feed, firstSeen: tick.ts, lastSeen: tick.ts,
          status: v?.status, stopId: v?.stopId, vehicleTs: v?.timestamp,
          arrivedAt: v?.status === "STOPPED_AT" ? v.timestamp : undefined,
          beats: 0, lastEta: new Map(), lastAdjusted: new Map(), bias: 0, biasN: 0, sig: "", changedAt: tick.ts, dirty: true,
        };
        this.mem.set(u.id, m);
      } else if (v && (v.stopId !== m.stopId || v.status !== m.status)) {
        // A wildly future timestamp is a feed error. A slightly future one is not: the lettered
        // lines deliberately push this value ahead as their own expected-departure estimate, and
        // the departure model depends on that, so only the implausible cases are corrected here.
        if (v.timestamp !== undefined && v.timestamp > tick.ts + 300) v.timestamp = tick.ts;
        const ts = v.timestamp ?? tick.ts;
        const base = { feedTs: tick.ts, tripId: u.id, route: u.route, direction: u.direction };
        // Left the stop we were at or heading to. Departures are observed only when the vehicle
        // goes IN_TRANSIT_TO with a fresh timestamp; a STOPPED_AT → STOPPED_AT jump means the
        // departure was never reported, and is estimated later from arrival + typical dwell.
        if (m.stopId && v.stopId !== m.stopId) {
          const tsChanged = v.timestamp !== undefined && v.timestamp !== m.vehicleTs;
          const observed = tsChanged && v.status !== "STOPPED_AT" && m.beats === 0;
          if (m.status === "STOPPED_AT" && !observed) {
            m.departedAt = undefined;
            m.departedEstimated = true;
          } else {
            const kind: EventKind = m.status === "STOPPED_AT" ? "depart" : "pass";
            const depTs = tsChanged ? v.timestamp! : tick.ts;
            events.push({ ...base, ts: depTs, stopId: m.stopId, kind, track: this.trackOf(m.u, m.stopId), estimated: !tsChanged });
            m.departedAt = depTs;
            m.departedEstimated = !tsChanged;
          }
          m.prevStop = m.stopId;
          m.prevArrivedAt = m.arrivedAt;
          m.arrivedAt = undefined;
          m.inferredPrev = undefined;
          m.beats = 0;
        }
        if (v.status === "STOPPED_AT" && v.stopId) {
          events.push({ ...base, ts, stopId: v.stopId, kind: "arrive", track: this.trackOf(u, v.stopId), estimated: v.timestamp === undefined });
          // What did *we* last say this arrival would be? Scoring against our own corrected
          // number is the point: the raw feed prediction is already corrected for by the
          // residual tables, and measuring against it double-counts that correction.
          const predicted = m.lastAdjusted.get(v.stopId);
          if (predicted !== undefined && v.timestamp !== undefined) {
            const residual = Math.max(-300, Math.min(300, ts - predicted));
            const w = m.biasN === 0 ? 1 : 0.4;
            m.bias = m.bias * (1 - w) + residual * w;
            m.biasN = Math.min(8, m.biasN + 1);
          }
          m.arrivedAt = ts;
          m.beats = 0;
        } else if (v.status === "INCOMING_AT" && v.stopId) {
          events.push({ ...base, ts, stopId: v.stopId, kind: "incoming", track: this.trackOf(u, v.stopId), estimated: v.timestamp === undefined });
        }
        m.status = v.status;
        m.stopId = v.stopId;
        m.vehicleTs = v.timestamp;
      } else if (v) {
        if (v.timestamp !== undefined && m.vehicleTs !== undefined && v.timestamp > m.vehicleTs) {
          const f = this.feedStats.get(tick.feed) ?? this.feedStats.set(tick.feed, { beats: 0, transit: 0 }).get(tick.feed)!;
          if (v.status === "STOPPED_AT") { m.beats++; f.beats++; } else f.transit++;
        }
        m.vehicleTs = v.timestamp;
      }

      // ETA revisions for the next few stops.
      for (let i = 0; i < Math.min(ETA_OBS_STOPS, u.stops.length); i++) {
        const s = u.stops[i];
        if (m.status === "STOPPED_AT" && m.stopId && parentOf(m.stopId) === parentOf(s.id)) continue;
        if (m.lastEta.get(s.id) === s.arrival) continue;
        m.lastEta.set(s.id, s.arrival);
        const atStop = m.status === "STOPPED_AT" ? m.stopId : undefined;
        const prevForObs = i === 0 ? (atStop ?? m.prevStop) : u.stops[i - 1].id;
        etaObs.push({
          obsTs: tick.ts, tripId: u.id, route: u.route, direction: u.direction, stopId: s.id, seq: i,
          predicted: s.arrival, prevStop: prevForObs, departedAt: atStop ? undefined : m.departedAt,
        });
      }
      const keep = new Set(u.stops.slice(0, ETA_OBS_STOPS).map((s) => s.id));
      for (const k of m.lastEta.keys()) if (!keep.has(k)) m.lastEta.delete(k);

      const sig = `${u.stops[0].id}|${u.stops[0].arrival}|${m.status}|${m.stopId}|${m.vehicleTs}|${u.stops.length}|${u.assigned}`;
      if (sig !== m.sig) { m.sig = sig; m.changedAt = tick.ts; m.dirty = true; }
      m.u = u;
      m.feed = tick.feed;
      m.lastSeen = tick.ts;
    }
    return { events, etaObs, fresh: true };
  }

  /**
   * The bias to apply, shrunk while the evidence is thin so one unusual stop cannot swing the
   * whole run, and capped so a data glitch cannot produce a nonsense prediction.
   */
  private tripBias(m: Memory): number {
    if (m.biasN === 0 || process.env.TRIP_BIAS === "0") return 0;
    const shrunk = m.bias * (m.biasN / (m.biasN + 1.5));
    return Math.max(-120, Math.min(120, shrunk));
  }

  private trackOf(u: TrainUpdate, stopId: string): string | undefined {
    return u.stops.find((s) => s.id === stopId)?.track;
  }

  /** Drop trains the feeds stopped mentioning. */
  expire(now: number) {
    for (const [id, m] of this.mem) {
      if (now - m.lastSeen > EXPIRE_AFTER) {
        this.mem.delete(id);
        this.removed.push(id);
      }
    }
  }

  get size(): number {
    return this.mem.size;
  }

  /** Full state of every tracked train at `now`. */
  states(now: number): TrainState[] {
    const { hour, dow } = nyHourDow(now);
    const cond = conditionsAt(now, this.timing.weather);
    const seen: { st: TrainState; lastSeen: number }[] = [];
    for (const m of this.mem.values()) {
      const st = this.stateOf(m, now, hour, dow, cond);
      if (st) seen.push({ st, lastSeen: m.lastSeen });
    }
    const out = this.dedupeByTrain(seen);
    const byId = this.assignLeaders(out);
    this.applyLeaderConstraint(out, byId, hour, cond);
    // The feed keeps publishing some trains long after they stop doing anything — one had been
    // "at a platform" for over three hours. It is still data, but it is not a running train, and
    // presenting it as one is worse than admitting we have lost track of it.
    for (const st of out) {
      const parked = st.phase === "dwelling" && st.arrivedAt !== undefined && now - st.arrivedAt > MAX_DWELL_S;
      // Our own eta is floored at the present — it never reads as past — so overdue-ness has to
      // be judged against the feed's raw prediction, which is not clamped.
      const overdue = st.phase === "moving" && st.etaRaw < now - MAX_OVERDUE_S;
      if (parked || overdue) st.stale = true;
    }
    return out;
  }

  private stateOf(m: Memory, now: number, hour: number, dow: number, cond: Conditions): TrainState | undefined {
    const u = m.u;
    const head = u.stops[0];
    if (!head) return undefined;
    const v = u.vehicle;
    const base = {
      id: u.id, route: u.route, direction: u.direction, trainId: u.trainId, assigned: u.assigned,
      // The predictions below are capped for the wire; the terminal comes from the full list —
      // the last stop we can actually name, since the feed's tail is sometimes a yard track. If
      // none of them are nameable the honest answer is that we do not know where it finishes,
      // rather than putting an internal id where a station name belongs.
      destination: [...u.stops].reverse().find((x) => this.net.station(x.id))?.id,
      updatedAt: m.changedAt,
    };

    // STOPPED_AT. Transit feeds: dwelling until the vehicle goes IN_TRANSIT_TO. Heartbeat feeds:
    // the departure is never reported, so the train leaves at arrival + typical dwell (sooner if
    // the trip update has already dropped the stop) and is then modelled as moving.
    if (m.status === "STOPPED_AT" && m.stopId && this.net.station(m.stopId)) {
      const at = m.stopId;
      // Whatever the feed says, a train cannot have arrived later than the moment being drawn:
      // "arrived in 30 seconds" is not a thing anyone can act on.
      const arrivedAt = Math.min(m.arrivedAt ?? m.vehicleTs ?? now, now);
      const atHead = parentOf(head.id) === parentOf(at);
      const nextIdx = u.stops.findIndex((s) => parentOf(s.id) !== parentOf(at));
      const next = nextIdx >= 0 ? u.stops[nextIdx] : undefined;
      const heartbeat = m.beats > 0 || this.isHeartbeatFeed(m.feed);
      const dwellOf = this.timing.dwell(at, hour, cond);
      let departAt = heartbeat ? arrivedAt + dwellOf : Infinity;
      if (heartbeat && !u.stops.some((s) => parentOf(s.id) === parentOf(at))) departAt = Math.min(departAt, now);
      if (now >= departAt && next && this.net.station(next.id)) {
        const { eta, sigma } = this.timing.adjustEta({ raw: next.arrival, now, route: u.route, prev: at, next: next.id, departedAt: departAt, hour, dow });
        return {
          ...base, phase: "moving", prevStop: at, departedAt: departAt, departedEstimated: true,
          nextStop: next.id, track: next.track, eta, etaRaw: next.arrival, sigma,
          runTime: this.timing.runTime(at, next.id, hour, u.route, cond),
          stops: this.predictions(u, now, hour, dow, at, nextIdx),
        };
      }
      // Numbered lines publish the expected departure as the current stop's "arrival".
      const expectedDeparture = heartbeat ? departAt : atHead ? head.arrival : arrivedAt + dwellOf;
      return {
        ...base, phase: "dwelling", prevStop: at, nextStop: at, track: this.trackOf(u, at) ?? head.track,
        arrivedAt, expectedDeparture, eta: arrivedAt, etaRaw: atHead ? head.arrival : arrivedAt, sigma: 0,
        stops: this.predictions(u, now, hour, dow, at, Math.max(0, nextIdx)),
      };
    }

    // Moving: the vehicle's target stop is next when the list still knows about it.
    let nextIdx = 0;
    if (v?.stopId && m.status !== "STOPPED_AT") {
      const idx = u.stops.findIndex((s) => parentOf(s.id) === parentOf(v.stopId!));
      if (idx >= 0) nextIdx = idx;
    }
    const next = u.stops[nextIdx];
    if (!this.net.station(next.id)) return undefined;

    const unstarted = !v && (!u.assigned || next.arrival - now > 60);
    if (unstarted) {
      const { eta, sigma } = this.timing.adjustEta({ raw: next.arrival, now, route: u.route, next: next.id, hour, dow });
      return { ...base, phase: "unstarted", nextStop: next.id, track: next.track, eta, etaRaw: next.arrival, sigma, stops: this.predictions(u, now, hour, dow, undefined, nextIdx) };
    }

    let prev = m.prevStop;
    const inferred = !prev;
    if (!prev) {
      m.inferredPrev ??= this.timing.inferPrev(u.route, next.id, next.track, u.stops.slice(nextIdx).map((s) => s.id), u.id);
      prev = m.inferredPrev;
    }
    let departedAt = m.departedAt;
    let departedEstimated = m.departedEstimated;
    if (departedAt === undefined && prev && m.prevArrivedAt !== undefined) {
      departedAt = Math.min(now, m.prevArrivedAt + this.timing.dwell(prev, hour, cond));
      departedEstimated = true;
    }
    const { eta, sigma } = this.timing.adjustEta({ raw: next.arrival, now, route: u.route, prev, next: next.id, departedAt, hour, dow, bias: this.tripBias(m) });
    return {
      ...base, phase: "moving", prevStop: prev, departedAt, departedEstimated, prevInferred: inferred,
      nextStop: next.id, track: next.track, eta, etaRaw: next.arrival, sigma,
      runTime: prev ? this.timing.runTime(prev, next.id, hour, u.route, cond) : undefined,
      stops: this.predictions(u, now, hour, dow, prev, nextIdx),
    };
  }

  private predictions(u: TrainUpdate, now: number, hour: number, dow: number, prev: string | undefined, from: number, bias = 0, adjusted?: Map<string, number>): StopPrediction[] {
    const out: StopPrediction[] = [];
    let p = prev;
    let floor = -Infinity;
    for (let i = from; i < Math.min(u.stops.length, 12); i++) {
      const s = u.stops[i];
      // A stop that is in no schedule cannot be drawn, named or navigated to; leave it out of
      // what we show rather than surfacing an internal id.
      if (!this.net.station(s.id)) { this.unknownStops.add(parentOf(s.id)); continue; }
      const { eta, sigma } = this.timing.adjustEta({ raw: s.arrival, now, route: u.route, prev: p, next: s.id, hour, dow, bias });
      // Each stop is corrected on its own, with its own segment and horizon, so the corrected
      // series can cross over itself and show a later stop arriving sooner — 158 such pairs across
      // the system, none of them present in the feed we started from. A train cannot reach a stop
      // before the one before it, so the sequence is held in order here, pushed later and never
      // earlier, by at least the time that stretch of track actually takes.
      const minRun = p ? Math.max(15, this.timing.runTime(p, s.id, hour, u.route) * 0.4) : 15;
      const ordered = Math.max(eta, floor + minRun);
      floor = ordered;
      out.push({ id: s.id, eta: ordered, etaRaw: s.arrival, sigma, track: s.track });
      adjusted?.set(s.id, ordered);
      p = s.id;
    }
    return out;
  }

  /**
   * The feed sometimes publishes one physical train under two trip ids — a full one and a short
   * supplement form, as in `099000_2..S01R` alongside `099000_2..S` — and the MTA's own train
   * identity gives them away as the same carriages. Drawn as-is that is two trains on one piece of
   * track. Keep whichever record is better informed: most recently seen, then the one that knows
   * where the train is, then the one that knows further ahead.
   */
  private dedupeByTrain(seen: { st: TrainState; lastSeen: number }[]): TrainState[] {
    const best = new Map<string, { st: TrainState; lastSeen: number }>();
    const out: TrainState[] = [];
    for (const entry of seen) {
      const key = entry.st.trainId;
      if (!key) { out.push(entry.st); continue; }
      const cur = best.get(key);
      if (!cur) { best.set(key, entry); continue; }
      const rank = (e: { st: TrainState; lastSeen: number }) =>
        [e.lastSeen, e.st.phase === "unstarted" ? 0 : 1, e.st.prevStop ? 1 : 0, e.st.stops.length] as const;
      const [al, ap, ad, as_] = rank(entry);
      const [bl, bp, bd, bs] = rank(cur);
      const better = al !== bl ? al > bl : ap !== bp ? ap > bp : ad !== bd ? ad > bd : as_ > bs;
      if (better) best.set(key, entry);
    }
    for (const e of best.values()) out.push(e.st);
    return out;
  }

  /**
   * A train cannot reach a platform before the train in front has left it. The feed predicts each
   * trip independently, so nothing stops it promising two arrivals thirty seconds apart on one
   * track; this is the constraint that the whole line's state lets us apply and a single trip's
   * data never could. States are visited in arrival order so a queue resolves front to back.
   */
  private applyLeaderConstraint(states: TrainState[], byId: Map<string, TrainState>, hour: number, cond: Conditions) {
    if (process.env.LEADER_CONSTRAINT === "0") return;
    for (const s of [...states].sort((a, b) => a.eta - b.eta)) {
      if (s.phase !== "moving" || !s.leaderId) continue;
      const leader = byId.get(s.leaderId);
      if (!leader || parentOf(leader.nextStop) !== parentOf(s.nextStop)) continue;
      const clears = leader.phase === "dwelling"
        ? (leader.expectedDeparture ?? leader.arrivedAt ?? s.eta)
        : leader.eta + this.timing.dwell(leader.nextStop, hour, cond);
      const earliest = clears + CLEARANCE_S;
      if (earliest <= s.eta) continue;
      // Pushing an arrival later is a real claim, so widen the spread with it rather than
      // pretending the new number is as certain as the old one.
      s.sigma = Math.max(s.sigma, Math.min(120, (earliest - s.eta) / 2));
      const pushedBy = earliest - s.eta;
      s.eta = earliest;
      s.heldBehind = true;
      if (s.stops.length && parentOf(s.stops[0].id) === parentOf(s.nextStop)) {
        s.stops[0] = { ...s.stops[0], eta: earliest, sigma: s.sigma };
        // Holding the first stop back without moving the rest would leave the second arriving
        // before the first. A train held at one platform is late for everything after it, so the
        // delay is carried down the run, decaying as later stops have room to make it up.
        for (let i = 1; i < s.stops.length; i++) {
          const carried = pushedBy * Math.max(0, 1 - i / 6);
          const shifted = s.stops[i].eta + carried;
          const ordered = Math.max(shifted, s.stops[i - 1].eta + 15);
          if (ordered === s.stops[i].eta) break;
          s.stops[i] = { ...s.stops[i], eta: ordered };
        }
      }
    }
  }

  /** Who is directly ahead: same segment and departed earlier, or dwelling at my next stop. */
  private assignLeaders(states: TrainState[]): Map<string, TrainState> {
    const dwellingAt = new Map<string, TrainState[]>();
    const onSegment = new Map<string, TrainState[]>();
    for (const s of states) {
      if (s.phase === "dwelling") {
        const k = `${s.direction}|${parentOf(s.nextStop)}`;
        (dwellingAt.get(k) ?? dwellingAt.set(k, []).get(k)!).push(s);
      } else if (s.phase === "moving" && s.prevStop) {
        const k = `${s.direction}|${parentOf(s.prevStop)}>${parentOf(s.nextStop)}`;
        (onSegment.get(k) ?? onSegment.set(k, []).get(k)!).push(s);
      }
    }
    const sameTrack = (a: TrainState, b: TrainState) => !a.track || !b.track || a.track === b.track;
    for (const s of states) {
      if (s.phase !== "moving" || !s.prevStop) continue;
      let leader: TrainState | undefined;
      const peers = onSegment.get(`${s.direction}|${parentOf(s.prevStop)}>${parentOf(s.nextStop)}`) ?? [];
      for (const p of peers) {
        if (p === s || !sameTrack(p, s)) continue;
        if (p.departedAt !== undefined && s.departedAt !== undefined && p.departedAt < s.departedAt) {
          if (!leader || (leader.departedAt ?? 0) < p.departedAt) leader = p;
        }
      }
      if (!leader) leader = (dwellingAt.get(`${s.direction}|${parentOf(s.nextStop)}`) ?? []).find((d) => sameTrack(d, s));
      s.leaderId = leader?.id;
      if (this.lastLeader.get(s.id) !== s.leaderId) {
        this.lastLeader.set(s.id, s.leaderId);
        const m = this.mem.get(s.id);
        if (m) m.dirty = true;
      }
    }
    return new Map(states.map((s) => [s.id, s]));
  }

  snapshot(now: number, live = true): StateSnapshot {
    const trains = this.states(now);
    for (const m of this.mem.values()) m.dirty = false;
    this.removed = [];
    return { ts: now, live, feeds: [...this.feeds.values()], trains };
  }

  /** Trains whose state changed since the last snapshot/delta, plus removals. */
  delta(now: number, live = true): StateDelta {
    const all = this.states(now);
    const trains = all.filter((s) => this.mem.get(s.id)?.dirty);
    for (const m of this.mem.values()) m.dirty = false;
    const removed = this.removed;
    this.removed = [];
    return { ts: now, live, feeds: [...this.feeds.values()], trains, removed };
  }
}
