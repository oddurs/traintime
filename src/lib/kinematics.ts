import type { LonLat, Motion, TrainPosition, TrainState } from "./types";
import { NetworkIndex, parentOf } from "./network";
import { alongPath, slicePath, type Path } from "./geo";

export interface KinematicsOptions {
  /** m/s² */
  accel: number;
  brake: number;
  /** Absolute speed cap, m/s. */
  vMaxAbs: number;
  /** Following distance behind a leader on the same segment, metres. */
  gap: number;
  /** Where to hold when the next platform is occupied, metres short of it. */
  platformHold: number;
}

const DEFAULTS: KinematicsOptions = { accel: 1.0, brake: 1.2, vMaxAbs: 27, gap: 180, platformHold: 120 };

interface Body {
  key: string;
  path: Path;
  L: number;
  vMax: number;
  s: number;
  v: number;
  motion: Motion;
}

/**
 * Moves trains like trains. Each body has a position and velocity along its segment; a
 * controller picks the cruise speed that meets the predicted arrival time, always respecting
 * acceleration limits, a braking curve into the platform, and the train ahead. When an ETA
 * slips, the train slows and holds — it never jumps backwards.
 */
export class Kinematics {
  private bodies = new Map<string, Body>();
  private opts: KinematicsOptions;

  constructor(private readonly net: NetworkIndex, opts: Partial<KinematicsOptions> = {}) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  step(states: TrainState[], now: number, dt: number): TrainPosition[] {
    const out: TrainPosition[] = [];
    const alive = new Set<string>();
    const byId = new Map(states.map((s) => [s.id, s]));
    for (const st of states) {
      alive.add(st.id);
      const pos = this.stepOne(st, byId, now, dt);
      if (pos) out.push(pos);
    }
    for (const id of this.bodies.keys()) if (!alive.has(id)) this.bodies.delete(id);
    return out;
  }

  private stationBody(st: TrainState, stop: string): Body {
    const s = this.net.station(stop);
    const p: LonLat = s ? [s.lon, s.lat] : [0, 0];
    return { key: `at:${parentOf(stop)}`, path: { pts: [p], cum: [0], length: 0 }, L: 0, vMax: 0, s: 0, v: 0, motion: "stopped" };
  }

  private stepOne(st: TrainState, byId: Map<string, TrainState>, now: number, dt: number): TrainPosition | undefined {
    let body = this.bodies.get(st.id);

    if (st.phase === "unstarted" || (st.phase === "dwelling" && (!body || parentOf(this.keyNext(body.key)) !== parentOf(st.nextStop)))) {
      body = this.stationBody(st, st.nextStop);
      this.bodies.set(st.id, body);
      return this.emit(st, body, now);
    }

    if (st.phase === "dwelling") {
      // Arrived on the segment we were animating: glide the rest of the way in, then sit.
      body!.motion = body!.s < body!.L - 1 ? "braking" : "stopped";
      this.integrate(body!, body!.s < body!.L - 1 ? Math.min(body!.vMax, Math.sqrt(2 * this.opts.brake * (body!.L - body!.s))) : 0, dt);
      return this.emit(st, body!, now);
    }

    // moving
    if (!st.prevStop) {
      body = this.stationBody(st, st.nextStop);
      this.bodies.set(st.id, body);
      return this.emit(st, body, now);
    }
    const key = `${st.prevStop}>${st.nextStop}`;
    if (!body || body.key !== key) {
      const path = this.net.pathBetween(st.route, st.prevStop, st.nextStop);
      const L = path.length;
      const runTime = st.runTime ?? Math.max(60, L / 12);
      const vMax = Math.min(this.opts.vMaxAbs, Math.max(6, (1.35 * L) / runTime));
      const departed = body && (body.key === `at:${parentOf(st.prevStop)}` || parentOf(this.keyNext(body.key)) === parentOf(st.prevStop));
      const fresh: Body = { key, path, L, vMax, s: 0, v: 0, motion: "accelerating" };
      if (!departed) {
        // First sight mid-segment: replay the controller from departure to now so the
        // placement is consistent with how the train would have been animated.
        const from = st.departedAt ?? st.eta - runTime;
        let t = Math.max(from, now - 1200);
        while (t < now) {
          const h = Math.min(1, now - t);
          this.integrate(fresh, this.control(fresh, st, t, undefined), h);
          t += h;
        }
      }
      body = fresh;
      this.bodies.set(st.id, body);
    }

    const leader = st.leaderId ? byId.get(st.leaderId) : undefined;
    const leaderBody = leader ? this.bodies.get(leader.id) : undefined;
    const target = this.control(body, st, now, leader && leaderBody ? { state: leader, body: leaderBody } : undefined);
    this.integrate(body, target, dt);
    return this.emit(st, body, now);
  }

  private keyNext(key: string): string {
    const i = key.indexOf(">");
    return i === -1 ? key.slice(3) : key.slice(i + 1);
  }

  /** Target speed for this instant. */
  private control(b: Body, st: TrainState, now: number, leader?: { state: TrainState; body: Body }): number {
    const { brake } = this.opts;
    const d = Math.max(0, b.L - b.s);
    if (d <= 0.5) return 0;
    const tau = st.eta - now;
    let u: number;
    if (tau <= 0) u = b.vMax;
    else {
      const disc = brake * brake * tau * tau - 2 * brake * d;
      u = disc < 0 ? b.vMax : brake * tau - Math.sqrt(disc);
    }
    if (u < 0.4) u = 0; // ETA far away for the distance left: hold here.
    let target = Math.min(u, b.vMax, Math.sqrt(2 * brake * d));
    if (leader) {
      let free: number | undefined;
      if (leader.body.key === b.key) free = leader.body.s - this.opts.gap - b.s;
      else if (leader.state.phase === "dwelling" && parentOf(leader.state.nextStop) === parentOf(st.nextStop)) free = b.L - this.opts.platformHold - b.s;
      if (free !== undefined) target = Math.min(target, Math.sqrt(2 * brake * Math.max(0, free)));
    }
    return target;
  }

  private integrate(b: Body, target: number, dt: number) {
    const { accel, brake } = this.opts;
    const v0 = b.v;
    const dv = Math.max(-brake * dt, Math.min(accel * dt, target - v0));
    b.v = Math.max(0, v0 + dv);
    b.s = Math.min(b.L, b.s + ((v0 + b.v) / 2) * dt);
    if (b.s >= b.L - 0.5) { b.s = b.L; b.v = 0; b.motion = "stopped"; return; }
    if (b.v < 0.05 && target < 0.05) b.motion = "holding";
    else if (target > b.v + 0.05) b.motion = "accelerating";
    else if (target < b.v - 0.05) b.motion = "braking";
    else b.motion = "cruising";
  }

  private emit(st: TrainState, b: Body, now: number): TrainPosition {
    const { p, bearing } = alongPath(b.path, b.s);
    let ribbon: LonLat[] | undefined;
    if (st.phase === "moving" && b.L > 0 && st.sigma > 0) {
      const spread = Math.min(b.L, Math.max(b.v, 2) * st.sigma);
      if (spread > 25) ribbon = slicePath(b.path, b.s - spread, b.s + spread);
    }
    void now;
    return {
      id: st.id, route: st.route, direction: st.direction, lon: p[0], lat: p[1], bearing,
      speed: b.v, phase: st.phase, motion: b.motion, s: b.s, length: b.L, ribbon, state: st,
    };
  }
}
