import type { TrainUpdate, VehicleStatus } from "./types";

/** MTA subway realtime feeds (no key required) and how often each regenerates, in seconds (measured). */
export const FEED_BASE = "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2F";
export const FEEDS: { id: string; cadence: number }[] = [
  { id: "gtfs", cadence: 5 },
  { id: "gtfs-l", cadence: 5 },
  { id: "gtfs-ace", cadence: 15 },
  { id: "gtfs-bdfm", cadence: 15 },
  { id: "gtfs-g", cadence: 15 },
  { id: "gtfs-jz", cadence: 15 },
  { id: "gtfs-nqrw", cadence: 15 },
  { id: "gtfs-si", cadence: 15 },
];

interface RawStopTime {
  stopId?: string;
  arrival?: { time?: number };
  departure?: { time?: number };
  nyctStopTimeUpdate?: { scheduledTrack?: string; actualTrack?: string };
}
interface RawTrip {
  tripId?: string;
  routeId?: string;
  nyctTripDescriptor?: { trainId?: string; isAssigned?: boolean };
}
interface RawEntity {
  tripUpdate?: { trip?: RawTrip; stopTimeUpdate?: RawStopTime[] };
  vehicle?: { trip?: RawTrip; stopId?: string; currentStatus?: VehicleStatus; timestamp?: number };
}
export interface RawFeed {
  header?: { timestamp?: number };
  entity?: RawEntity[];
}

/** Minimal protobufjs surface we rely on, so this file works in Node and the browser alike. */
export interface ProtoType {
  decode(buf: Uint8Array): unknown;
  toObject(msg: unknown, opts: Record<string, unknown>): unknown;
}

export type Decoder = (buf: Uint8Array) => { ts: number; trains: TrainUpdate[] };

export function makeDecoder(FeedMessage: ProtoType): Decoder {
  return (buf) => {
    const msg = FeedMessage.decode(buf);
    const obj = FeedMessage.toObject(msg, { longs: Number, enums: String, defaults: false }) as RawFeed;
    return { ts: obj.header?.timestamp ?? 0, trains: normalize(obj) };
  };
}

/** Collapse a decoded feed into one TrainUpdate per trip. */
export function normalize(feed: RawFeed): TrainUpdate[] {
  const trains = new Map<string, TrainUpdate>();
  for (const ent of feed.entity ?? []) {
    const tu = ent.tripUpdate;
    const vp = ent.vehicle;
    const trip = tu?.trip ?? vp?.trip;
    if (!trip?.tripId) continue;
    let t = trains.get(trip.tripId);
    if (!t) {
      t = { id: trip.tripId, route: trip.routeId ?? "", direction: "N", stops: [], assigned: true };
      trains.set(trip.tripId, t);
    }
    if (trip.routeId) t.route = trip.routeId;
    const ext = trip.nyctTripDescriptor;
    if (ext) {
      if (ext.trainId) t.trainId = ext.trainId;
      if (ext.isAssigned !== undefined) t.assigned = ext.isAssigned;
    }
    if (tu) {
      t.stops = (tu.stopTimeUpdate ?? [])
        .filter((s) => !!s.stopId)
        .map((s) => {
          const arr = s.arrival?.time;
          const dep = s.departure?.time;
          const x = s.nyctStopTimeUpdate;
          return { id: s.stopId!, arrival: arr ?? dep ?? 0, departure: dep ?? arr ?? 0, track: x?.actualTrack ?? x?.scheduledTrack };
        })
        .filter((s) => s.arrival > 0);
    }
    if (vp) {
      t.vehicle = { stopId: vp.stopId, status: vp.currentStatus ?? "IN_TRANSIT_TO", timestamp: vp.timestamp };
    }
  }
  const out: TrainUpdate[] = [];
  for (const t of trains.values()) {
    if (t.stops.length === 0) continue;
    const suffix = t.stops[0].id.slice(-1);
    if (suffix !== "N" && suffix !== "S") continue;
    t.direction = suffix;
    out.push(t);
  }
  return out;
}

export async function fetchFeed(id: string): Promise<{ buf?: Uint8Array; ms: number; error?: string }> {
  const started = Date.now();
  try {
    const res = await fetch(FEED_BASE + id, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { ms: Date.now() - started, error: `HTTP ${res.status}` };
    return { buf: new Uint8Array(await res.arrayBuffer()), ms: Date.now() - started };
  } catch (e) {
    return { ms: Date.now() - started, error: e instanceof Error ? e.message : String(e) };
  }
}
