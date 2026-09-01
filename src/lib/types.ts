export type LonLat = [number, number];
export type Direction = "N" | "S";
export type VehicleStatus = "INCOMING_AT" | "STOPPED_AT" | "IN_TRANSIT_TO";

// ---------------------------------------------------------------------------
// Static network (public/data/network.json, built by scripts/build-network.ts)

export interface RouteInfo {
  id: string;
  name: string;
  color: string;
  textColor: string;
  sortOrder: number;
}

export interface Station {
  id: string;
  name: string;
  lat: number;
  lon: number;
}

export interface Network {
  generatedAt: string;
  feedVersion: string;
  routes: Record<string, RouteInfo>;
  stations: Record<string, Station>;
  /** Track geometry keyed by canonical "A-B" (A < B), ordered from A to B. */
  segments: Record<string, LonLat[]>;
  /** route -> directional stop id -> directional stop ids that precede it. */
  prevOf: Record<string, Record<string, string[]>>;
  routeSegments: Record<string, string[]>;
  /** Scheduled run time in seconds keyed by canonical "A-B". */
  schedRun: Record<string, number>;
  /** Parent station id -> routes that serve it, in official order. */
  stationRoutes: Record<string, string[]>;
  /** Segment key -> route -> [band offset about the centreline, services sharing the corridor]. */
  segmentSlots: Record<string, Record<string, [number, number]>>;
  /** Station id -> the complex it belongs to; a rider's "Times Sq" is five GTFS stations. */
  complexOf: Record<string, string>;
  /** Complex key -> its name, member stations and the routes they collectively serve. */
  complexes: Record<string, { name: string; stations: string[]; routes: string[] }>;
  /** GTFS shape id -> its ordered directional stop ids, for exact predecessor lookup. */
  shapeStops: Record<string, string[]>;
  /**
   * Segment key -> route -> the band offset each end of the segment should reach, halfway to the
   * neighbouring segment's. A service changing band splays across the station instead of stepping.
   */
  laneEnds: Record<string, Record<string, [number, number]>>;
  /**
   * Segment key -> route -> [which trunk colour, which service within that colour]. Colours stay
   * apart at every zoom; services sharing one merge into a single trunk line as you zoom out.
   */
  bandParts: Record<string, Record<string, [number, number]>>;
  /**
   * Whether a segment's stored point order runs with (+1) or against (-1) its corridor. Segment
   * keys are ordered by station id, which is not geography, so without this a band can land on
   * the wrong side of the track wherever that ordering reverses.
   */
  segDir: Record<string, number>;
  /** Per route, the continuous strokes to draw: an ordered station sequence sharing one lane. */
  routeRuns: Record<string, { slot: number; shared: number; z: number; side: number; cband: number; sband: number; stops: string[] }[]>;
}

// ---------------------------------------------------------------------------
// Decoded realtime feed

export interface StopTime {
  /** Directional stop id, e.g. "A24S". */
  id: string;
  arrival: number;
  departure: number;
  /** NYCT actual track, e.g. "A1". */
  track?: string;
}

export interface TrainUpdate {
  id: string;
  route: string;
  direction: Direction;
  stops: StopTime[];
  vehicle?: {
    stopId?: string;
    status: VehicleStatus;
    timestamp?: number;
  };
  trainId?: string;
  assigned: boolean;
}

export interface FeedTick {
  feed: string;
  /** Feed header timestamp (when the MTA generated it). */
  ts: number;
  fetchedAt: number;
  trains: TrainUpdate[];
}

export interface FeedStatus {
  id: string;
  ok: boolean;
  timestamp?: number;
  error?: string;
  ms: number;
}

// ---------------------------------------------------------------------------
// Tracked state (what the server streams; what the client animates)

export type TrainPhase = "moving" | "dwelling" | "unstarted";

export interface StopPrediction {
  id: string;
  eta: number;
  etaRaw: number;
  sigma: number;
  track?: string;
}

export interface TrainState {
  id: string;
  route: string;
  direction: Direction;
  trainId?: string;
  assigned: boolean;
  phase: TrainPhase;
  /** Directional id of the stop the train most recently left (moving) or is at (dwelling). */
  prevStop?: string;
  departedAt?: number;
  /** True when the departure time was modelled rather than reported by the feed. */
  departedEstimated?: boolean;
  /** True when we guessed which stop the train came from (first sight mid-segment). */
  prevInferred?: boolean;
  nextStop: string;
  /** Adjusted arrival time at nextStop. */
  eta: number;
  etaRaw: number;
  /** 1-sigma uncertainty on eta, seconds. */
  sigma: number;
  track?: string;
  /** Directional stop id of this run's last stop — the terminal, from the full feed list. */
  destination?: string;
  arrivedAt?: number;
  expectedDeparture?: number;
  /** Train directly ahead on the same track (same segment, or dwelling at nextStop). */
  leaderId?: string;
  /** True when this train's arrival is limited by the one in front rather than by the track. */
  heldBehind?: boolean;
  /** The feed still publishes it, but nothing about it has changed for far too long. */
  stale?: boolean;
  /**
   * The one observation the feed ever gives us from between two stations: the moment a train
   * entered its final approach, and how long that approach usually takes at this platform.
   * Everything else about a position is inferred; this is measured.
   */
  approach?: { since: number; typical: number };
  /** Typical run time for the current segment, seconds (learned → scheduled → geometric). */
  runTime?: number;
  stops: StopPrediction[];
  updatedAt: number;
}

export interface StateSnapshot {
  ts: number;
  live: boolean;
  feeds: FeedStatus[];
  trains: TrainState[];
}

export interface StateDelta {
  ts: number;
  live: boolean;
  feeds?: FeedStatus[];
  trains: TrainState[];
  removed: string[];
}

export type Motion = "accelerating" | "cruising" | "braking" | "holding" | "stopped";

/** What the panel is showing: nothing in particular, a station board, or one train. */
export type Selection = { kind: "none" } | { kind: "station"; id: string } | { kind: "train"; id: string };

export interface TrainPosition {
  id: string;
  route: string;
  direction: Direction;
  lon: number;
  lat: number;
  bearing: number;
  /** m/s */
  speed: number;
  phase: TrainPhase;
  motion: Motion;
  /** Metres along the current segment, and its length. */
  s: number;
  length: number;
  /** Track geometry covering ±1σ of arrival time around the marker. */
  ribbon?: LonLat[];
  state: TrainState;
}

// ---------------------------------------------------------------------------
// Learned timing (data/timing.json, built by scripts/learn-timing.ts)

export interface Stat {
  p50: number;
  p16?: number;
  p84?: number;
  n: number;
}

export interface ResidualStat {
  median: number;
  /** 68th percentile of |residual − median|: a calibrated 1σ. */
  p68: number;
  n: number;
}

export interface TimingTables {
  generatedAt: string;
  /** Conditional run-time estimates: segment, hour of week, daypart, weather. */
  runHier?: import("./hierarchy").Hierarchy;
  /** Conditional dwell estimates, rooted at the platform rather than the route. */
  dwellHier?: import("./hierarchy").Hierarchy;
  /**
   * Whether each hierarchy actually beat the flat per-cell median on held-out data. Conditioning
   * only helps once there is enough history to support it; until then the simpler estimator is
   * better and these stay false, so the model never gets more elaborate than the data warrants.
   */
  hierGate?: {
    run: { active: boolean; k: number; shape?: string; flatMae: number; hierMae: number; testRows: number };
    dwell: { active: boolean; k: number; shape?: string; flatMae: number; hierMae: number; testRows: number };
  };
  window: { from: string; to: string };
  samples: { events: number; etaObs: number };
  /** "A24S>A27S" → observed run time, departure to arrival. */
  runTime: Record<string, Stat>;
  /** "A24S>A27S@18" → by hour of day. */
  runTimeHour: Record<string, Stat>;
  /** "A24S>A27S" → arrival at prev to arrival at next (dwell + run); observable on every feed. */
  a2a: Record<string, Stat>;
  /** Median dwell across stations that report departures; the prior for stations that don't. */
  dwellGlobal: number;
  /** "A27S" → arrival to departure. */
  dwell: Record<string, Stat>;
  dwellHour: Record<string, Stat>;
  /** "A27S" → INCOMING_AT to STOPPED_AT. */
  approach: Record<string, Stat>;
  /** "seg:A24S>A27S|h1" / "route:A|h1" / "all|h1" → actual − predicted arrival. */
  residual: Record<string, ResidualStat>;
  /** "A|A27S|A1" → { "A24S": count }: which stop precedes a stop, by route and actual track. */
  prevByTrack: Record<string, Record<string, number>>;
}

/** Exported scikit-learn HistGradientBoostingRegressor (scripts/train_eta_model.py). */
export interface GbmModel {
  generatedAt: string;
  features: string[];
  categories: Record<string, Record<string, number>>;
  baseline: number;
  trees: GbmTree[];
  metrics?: Record<string, number>;
  /** Held-out 1σ of the model's own error, per horizon bucket — the honest spread to publish. */
  sigmaByBucket?: Record<string, number>;
  /**
   * The model's own held-out spread per horizon *and* daypart, keyed "h2|owl".
   *
   * One spread for the whole day is too narrow at night and too wide at rush hour: scored window
   * by window, overnight covered 57% of arrivals inside 1σ against a 68% target while the peaks
   * sat at 67%. Confidence has to be honest in every part of the day, not on average.
   */
  sigmaByBucketDaypart?: Record<string, number>;
}

export interface GbmTree {
  /** Parallel arrays indexed by node. */
  value: number[];
  feature: number[];
  threshold: number[];
  left: number[];
  right: number[];
  missingLeft: number[];
  leaf: number[];
}
