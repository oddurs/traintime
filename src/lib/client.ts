/**
 * Typed client for the bound poller API — the same calls the site itself makes.
 *
 *   const tt = new BoundClient("http://localhost:7118");
 *   const stop = tt.stream((msg) => console.log(msg.kind, msg.data.trains.length));
 */
import type { StateDelta, StateSnapshot } from "./types";

export interface Recordings { from: number; to: number; ticks: number }
export interface TimingInfo {
  learned: boolean;
  model: boolean;
  tables?: { generatedAt: string; window: { from: string; to: string }; samples: { events: number; etaObs: number }; runTime: number; residual: number } | null;
}
export interface DensityBucket { t: number; arrivals: number }
export interface LineHealth {
  route: string;
  arrivals: number;
  headwayP50: number | null;
  headwayP90: number | null;
  dwellP50: number | null;
  /** What this line normally does at this daypart, from our own history. */
  headwayUsual: number | null;
  /** Above 1 means trains are coming less often than usual. */
  headwayRatio: number | null;
  /** Median seconds the MTA's own prediction was off, at this window. */
  etaBias: number | null;
}
export type StreamMessage = { kind: "snapshot"; data: StateSnapshot } | { kind: "delta"; data: StateDelta } | { kind: "end" };

export class BoundClient {
  constructor(private readonly base = "/api/poller") {}

  private async json<T>(path: string, signal?: AbortSignal): Promise<T> {
    const r = await fetch(`${this.base}${path}`, { cache: "no-store", signal });
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
    return r.json() as Promise<T>;
  }

  health = (signal?: AbortSignal) => this.json<{ ok: boolean; trains: number; clock: number }>("/health", signal);
  state = (signal?: AbortSignal) => this.json<StateSnapshot>("/state", signal);
  timing = (signal?: AbortSignal) => this.json<TimingInfo>("/timing", signal);
  recordings = (signal?: AbortSignal) => this.json<Recordings>("/recordings", signal);
  density = (from: number, to: number, buckets = 120, signal?: AbortSignal) =>
    this.json<{ from: number; to: number; step: number; buckets: DensityBucket[] }>(`/density?from=${from}&to=${to}&buckets=${buckets}`, signal);
  lines = (from: number, to: number, signal?: AbortSignal) =>
    this.json<{ from: number; to: number; daypart: string; lines: LineHealth[] }>(`/lines?from=${from}&to=${to}`, signal);

  /** Live states. Returns an unsubscribe function. */
  stream(onMessage: (m: StreamMessage) => void, onError?: (e: Event) => void): () => void {
    return this.sse("/stream", onMessage, onError);
  }

  /** Recorded states replayed at `speed`× real time. Returns an unsubscribe function. */
  replay(from: number, to: number, speed: number, onMessage: (m: StreamMessage) => void, onError?: (e: Event) => void): () => void {
    return this.sse(`/replay?from=${from}&to=${to}&speed=${speed}`, onMessage, onError);
  }

  private sse(path: string, onMessage: (m: StreamMessage) => void, onError?: (e: Event) => void): () => void {
    const es = new EventSource(`${this.base}${path}`);
    es.addEventListener("snapshot", (e) => onMessage({ kind: "snapshot", data: JSON.parse((e as MessageEvent).data) }));
    es.addEventListener("delta", (e) => onMessage({ kind: "delta", data: JSON.parse((e as MessageEvent).data) }));
    es.addEventListener("end", () => { onMessage({ kind: "end" }); es.close(); });
    if (onError) es.onerror = onError;
    return () => es.close();
  }
}
