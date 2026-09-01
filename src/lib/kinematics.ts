import type { LonLat, Motion, TrainPosition, TrainState } from "./types";
import { NetworkIndex, parentOf } from "./network";
import { alongPath, headingAt, lerpBearing, slicePath, type Path } from "./geo";

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

/**
 * How fast the marker may close on a position the feed measured, in m/s. Bounded so that acting
 * on a measurement is a correction the eye can follow rather than a teleport.
 */
const APPROACH_CATCH_UP = 12;

const DEFAULTS: KinematicsOptions = { accel: 1.0, brake: 1.2, vMaxAbs: 27, gap: 180, platformHold: 120 };

interface Body {
  key: string;
  path: Path;
  L: number;
  vMax: number;
  s: number;
  v: number;
  motion: Motion;
  /** Extra closing speed currently being applied to reach a measured position, in m/s. */
  catchUp?: number;
  /** Smoothed compass heading, so the marker sweeps through curves instead of snapping. */
  heading: number;
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
    const prev = this.bodies.get(st.id);
    return { key: `at:${parentOf(stop)}`, path: { pts: [p], cum: [0], length: 0 }, L: 0, vMax: 0, s: 0, v: 0, motion: "stopped", heading: prev?.heading ?? 0 };
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
      this.steer(body!, dt);
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
      const fresh: Body = { key, path, L, vMax, s: 0, v: 0, motion: "accelerating", heading: body?.heading ?? headingAt(path, 0) };
      if (!departed) {
        // First sight mid-segment: replay the controller from departure to now so the
        // placement is consistent with how the train would have been animated.
        const from = st.departedAt ?? st.eta - runTime;
        let t = Math.max(from, now - 1200);
        while (t < now) {
          const h = Math.min(1, now - t);
          this.integrate(fresh, this.control(fresh, st, t, h), h);
          t += h;
        }
      }
      body = fresh;
      this.bodies.set(st.id, body);
    }

    const leader = st.leaderId ? byId.get(st.leaderId) : undefined;
    const leaderBody = leader ? this.bodies.get(leader.id) : undefined;
    const target = this.control(body, st, now, dt, leader && leaderBody ? { state: leader, body: leaderBody } : undefined);
    this.integrate(body, target, dt);
    this.applyApproachFix(body, st, dt);
    this.steer(body, dt);
    return this.emit(st, body, now);
  }

  private keyNext(key: string): string {
    const i = key.indexOf(">");
    return i === -1 ? key.slice(3) : key.slice(i + 1);
  }

  /** Target speed for this instant. */
  private control(b: Body, st: TrainState, now: number, dt: number, leader?: { state: TrainState; body: Body }): number {
    const { brake } = this.opts;
    /*
     * The distance left, as it will be once this step has been taken.
     *
     * Braking against the distance at the *start* of a step starts the brake one step late, and
     * because deceleration is capped the train can never make the time back: it arrived at the
     * platform still doing 8.8 m/s and was snapped to a stand. Looking one step ahead is the
     * whole fix, and it is only visible if you assert that a train's speed is one it could
     * actually stop from.
     */
    const d = Math.max(0, b.L - b.s - b.v * dt);
    if (b.L - b.s <= 0.5) return 0;
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

  /**
   * The one moment the feed tells us where a train is between two stations.
   *
   * When a vehicle reports INCOMING_AT, it has entered its final approach — on the numbered
   * lines that arrives for 90-97% of stops, a median 13 s before the train berths, and it is the
   * only position measurement in the entire feed. Everything else here is inference from
   * predicted times. So the marker is pulled onto the braking curve that ends at the platform in
   * the time this platform's approach usually takes.
   *
   * The correction only ever moves a train forward. If the marker is already past where the
   * measurement says it is, the honest response is to stop and let reality catch up rather than
   * to slide backwards, which no train does.
   */
  private applyApproachFix(b: Body, st: TrainState, dt: number) {
    const a = st.approach;
    if (!a || b.L === 0 || process.env.APPROACH_FIX === "0") { b.catchUp = 0; return; }
    // Where a train braking to a stand in this platform's typical approach time would have been
    // when its approach began. Computed from `typical` alone, so it is a fixed point on the
    // segment rather than a target that slides onto the platform as the approach elapses — that
    // earlier shape delivered the marker to the platform early whenever the real approach ran
    // long, which is often: approach times spread from 5 s to 23 s around a 13 s median, and it
    // took the share of markers arriving early from 16% to 45%.
    const dist = Math.min(b.L * 0.5, 0.5 * this.opts.brake * a.typical * a.typical);
    const floor = b.L - dist;
    // Forward only, and never the whole way in: the measurement says "at least this far along",
    // and it is the arrival event, not this, that berths a train.
    //
    // The closing speed is bounded twice over, because a correction that is right about the
    // position and wrong about the physics still reads as a glitch. It may not take the marker
    // past the line's own top speed, and it ramps in and out under an acceleration limit, so a
    // measurement lands as a train hurrying rather than as a train teleporting. Left unbounded
    // it drew 39 m/s and 17 m/s² — 140 km/h, on a system whose trains do 89.
    const want = b.s < floor ? Math.min(APPROACH_CATCH_UP, Math.max(0, b.vMax - b.v)) : 0;
    const slew = this.opts.accel * 2 * dt;
    const prev = b.catchUp ?? 0;
    b.catchUp = want > prev ? Math.min(want, prev + slew) : Math.max(want, prev - slew);
    if (b.catchUp > 0 && b.s < floor) b.s = Math.min(floor, b.s + b.catchUp * dt);
  }

  /**
   * Turn the marker toward the track's heading. The target is measured across a window of the
   * path, and the turn itself is rate-limited, so a vertex or a correction cannot snap the arrow.
   */
  private steer(b: Body, dt: number) {
    if (b.L === 0) return;
    const target = headingAt(b.path, b.s);
    const k = 1 - Math.exp(-dt * 3.5);
    b.heading = lerpBearing(b.heading, target, k);
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
    const { p } = alongPath(b.path, b.s);
    let ribbon: LonLat[] | undefined;
    if (st.phase === "moving" && b.L > 0 && st.sigma > 0) {
      const spread = Math.min(b.L, Math.max(b.v, 2) * st.sigma);
      if (spread > 25) ribbon = slicePath(b.path, b.s - spread, b.s + spread);
    }
    void now;
    return {
      id: st.id, route: st.route, direction: st.direction, lon: p[0], lat: p[1], bearing: b.heading,
      speed: b.v, phase: st.phase, motion: b.motion, s: b.s, length: b.L, ribbon, state: st,
    };
  }
}
