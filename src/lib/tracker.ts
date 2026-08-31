import type {
  Direction, FeedStatus, FeedTick, StateDelta, StateSnapshot, StopPrediction, TrainState, TrainUpdate, VehicleStatus,
} from "./types";
import { NetworkIndex, parentOf } from "./network";
import { Timing } from "./timing";

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
  sig: string;
  changedAt: number;
  dirty: boolean;
}

const EXPIRE_AFTER = 120;
const ETA_OBS_STOPS = 3;

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
          beats: 0, lastEta: new Map(), sig: "", changedAt: tick.ts, dirty: true,
        };
        this.mem.set(u.id, m);
      } else if (v && (v.stopId !== m.stopId || v.status !== m.status)) {
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
    const out: TrainState[] = [];
    for (const m of this.mem.values()) {
      const st = this.stateOf(m, now, hour, dow);
      if (st) out.push(st);
    }
    this.assignLeaders(out);
    return out;
  }

  private stateOf(m: Memory, now: number, hour: number, dow: number): TrainState | undefined {
    const u = m.u;
    const head = u.stops[0];
    if (!head) return undefined;
    const v = u.vehicle;
    const base = {
      id: u.id, route: u.route, direction: u.direction, trainId: u.trainId, assigned: u.assigned,
      // The predictions below are capped for the wire; the terminal comes from the full list.
      destination: u.stops[u.stops.length - 1]?.id,
      updatedAt: m.changedAt,
    };

    // STOPPED_AT. Transit feeds: dwelling until the vehicle goes IN_TRANSIT_TO. Heartbeat feeds:
    // the departure is never reported, so the train leaves at arrival + typical dwell (sooner if
    // the trip update has already dropped the stop) and is then modelled as moving.
    if (m.status === "STOPPED_AT" && m.stopId && this.net.station(m.stopId)) {
      const at = m.stopId;
      const arrivedAt = m.arrivedAt ?? m.vehicleTs ?? now;
      const atHead = parentOf(head.id) === parentOf(at);
      const nextIdx = u.stops.findIndex((s) => parentOf(s.id) !== parentOf(at));
      const next = nextIdx >= 0 ? u.stops[nextIdx] : undefined;
      const heartbeat = m.beats > 0 || this.isHeartbeatFeed(m.feed);
      const dwellOf = this.timing.dwell(at, hour);
      let departAt = heartbeat ? arrivedAt + dwellOf : Infinity;
      if (heartbeat && !u.stops.some((s) => parentOf(s.id) === parentOf(at))) departAt = Math.min(departAt, now);
      if (now >= departAt && next && this.net.station(next.id)) {
        const { eta, sigma } = this.timing.adjustEta({ raw: next.arrival, now, route: u.route, prev: at, next: next.id, departedAt: departAt, hour, dow });
        return {
          ...base, phase: "moving", prevStop: at, departedAt: departAt, departedEstimated: true,
          nextStop: next.id, track: next.track, eta, etaRaw: next.arrival, sigma,
          runTime: this.timing.runTime(at, next.id, hour),
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
      m.inferredPrev ??= this.timing.inferPrev(u.route, next.id, next.track, u.stops.slice(nextIdx).map((s) => s.id));
      prev = m.inferredPrev;
    }
    let departedAt = m.departedAt;
    let departedEstimated = m.departedEstimated;
    if (departedAt === undefined && prev && m.prevArrivedAt !== undefined) {
      departedAt = Math.min(now, m.prevArrivedAt + this.timing.dwell(prev, hour));
      departedEstimated = true;
    }
    const { eta, sigma } = this.timing.adjustEta({ raw: next.arrival, now, route: u.route, prev, next: next.id, departedAt, hour, dow });
    return {
      ...base, phase: "moving", prevStop: prev, departedAt, departedEstimated, prevInferred: inferred,
      nextStop: next.id, track: next.track, eta, etaRaw: next.arrival, sigma,
      runTime: prev ? this.timing.runTime(prev, next.id, hour) : undefined,
      stops: this.predictions(u, now, hour, dow, prev, nextIdx),
    };
  }

  private predictions(u: TrainUpdate, now: number, hour: number, dow: number, prev: string | undefined, from: number): StopPrediction[] {
    const out: StopPrediction[] = [];
    let p = prev;
    for (let i = from; i < Math.min(u.stops.length, 12); i++) {
      const s = u.stops[i];
      const { eta, sigma } = this.timing.adjustEta({ raw: s.arrival, now, route: u.route, prev: p, next: s.id, hour, dow });
      out.push({ id: s.id, eta, etaRaw: s.arrival, sigma, track: s.track });
      p = s.id;
    }
    return out;
  }

  /** Who is directly ahead: same segment and departed earlier, or dwelling at my next stop. */
  private assignLeaders(states: TrainState[]) {
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
