"use client";

import { useEffect, useRef, useState } from "react";
import type { FeedStatus, StateDelta, StateSnapshot, TrainState } from "./types";
import type { NetworkIndex } from "./network";
import type { BrowserSource } from "./browserSource";
import { POLLER_URL } from "./basePath";

export type StreamMode = { kind: "live" } | { kind: "replay"; from: number; to: number; speed: number };
export type StreamSource = "poller" | "browser" | "none";

export interface StreamStatus {
  connected: boolean;
  live: boolean;
  /** Where the states come from: the poller service, or tracking done in this browser. */
  source: StreamSource;
  /** Simulation clock at the last message, and when (performance.now) we received it. */
  clockTs: number;
  wallAt: number;
  speed: number;
  ended: boolean;
  error?: string;
  messages: number;
  /** In-browser mode: the residual model finished loading in the background. */
  modelReady: boolean;
}

/** Is a poller reachable through the site's /api proxy? (Never on the static deployment.) */
async function pollerAvailable(): Promise<boolean> {
  try {
    const r = await fetch(`${POLLER_URL}/health`, { cache: "no-store", signal: AbortSignal.timeout(3000) });
    if (!r.ok) return false;
    const j = (await r.json()) as { ok?: boolean };
    return j.ok === true;
  } catch {
    return false;
  }
}

/**
 * Subscribes to train states: the poller's live stream or a replay when a poller is reachable,
 * otherwise in-browser tracking straight from the MTA feeds (which needs the network, so it waits
 * for it). States live in a ref (mutated in place for the animation loop) and are mirrored into
 * `trains` state for React consumers.
 */
export function useTrainStream(mode: StreamMode, index: NetworkIndex | null) {
  const statesRef = useRef(new Map<string, TrainState>());
  const [trains, setTrains] = useState<TrainState[]>([]);
  const [feeds, setFeeds] = useState<FeedStatus[]>([]);
  const [status, setStatus] = useState<StreamStatus>({
    connected: false, live: mode.kind === "live", source: "none", clockTs: 0, wallAt: 0,
    speed: mode.kind === "replay" ? mode.speed : 1, ended: false, messages: 0, modelReady: false,
  });
  const statusRef = useRef(status);
  useEffect(() => { statusRef.current = status; }, [status]);

  const modeKey = JSON.stringify(mode);
  useEffect(() => {
    const m: StreamMode = JSON.parse(modeKey);
    let es: EventSource | null = null;
    let local: BrowserSource | null = null;
    let cancelled = false;
    statesRef.current = new Map();

    const applySnapshot = (snap: StateSnapshot) => {
      statesRef.current = new Map(snap.trains.map((t) => [t.id, t]));
      setFeeds(snap.feeds);
      setTrains([...statesRef.current.values()]);
    };
    const applyDelta = (d: StateDelta) => {
      for (const t of d.trains) statesRef.current.set(t.id, t);
      for (const id of d.removed) statesRef.current.delete(id);
      if (d.feeds) setFeeds(d.feeds);
      setTrains([...statesRef.current.values()]);
    };
    const tick = (ts: number, live: boolean, source: StreamSource) =>
      setStatus((s) => ({ ...s, connected: true, live, source, clockTs: ts, wallAt: performance.now(), error: undefined, messages: s.messages + 1 }));

    const connectPoller = () => {
      const url = m.kind === "live" ? `${POLLER_URL}/stream` : `${POLLER_URL}/replay?from=${m.from}&to=${m.to}&speed=${m.speed}`;
      es = new EventSource(url);
      es.onopen = () => {
        setTrains([]);
        setStatus((s) => ({ ...s, connected: true, source: "poller", live: m.kind === "live", speed: m.kind === "replay" ? m.speed : 1, ended: false, error: undefined, clockTs: 0, messages: 0 }));
      };
      es.addEventListener("snapshot", (e) => { const snap = JSON.parse((e as MessageEvent).data) as StateSnapshot; applySnapshot(snap); tick(snap.ts, snap.live, "poller"); });
      es.addEventListener("delta", (e) => { const d = JSON.parse((e as MessageEvent).data) as StateDelta; applyDelta(d); tick(d.ts, d.live, "poller"); });
      es.addEventListener("end", () => { setStatus((s) => ({ ...s, ended: true })); es?.close(); });
      es.onerror = () => {
        setStatus((s) => ({ ...s, connected: false, error: m.kind === "live" ? "reconnecting…" : "replay stream failed" }));
        if (m.kind === "replay") es?.close();
      };
    };

    /*
     * Tracking the whole system in this browser, when there is no poller to do it.
     *
     * Loaded only if that turns out to be the case. It brings a protobuf decoder, the tracker, the
     * timing tables and the gradient-boosted model with it — a large fraction of the bundle for a
     * path most visitors never take, and it was being downloaded, parsed and compiled by every one
     * of them before the first train appeared.
     */
    const connectBrowser = async () => {
      if (!index) return; // in-browser tracking needs the network; retried when it lands
      setStatus((s) => ({ ...s, source: "browser", live: true, speed: 1, ended: false, error: "fetching feeds…", clockTs: 0, messages: 0 }));
      try {
        const { BrowserSource } = await import("./browserSource");
        if (cancelled) return;
        local = new BrowserSource(index, (msg) => {
          if (msg.kind === "timing") { setStatus((s) => ({ ...s, modelReady: msg.model })); return; }
          if (msg.kind === "snapshot") applySnapshot(msg.data); else applyDelta(msg.data);
          tick(msg.data.ts, true, "browser");
        });
        await local.start();
      } catch (e) {
        setStatus((s) => ({ ...s, connected: false, error: `in-browser tracking failed: ${e instanceof Error ? e.message : e}` }));
      }
    };

    pollerAvailable().then((ok) => {
      if (cancelled) return;
      if (ok) connectPoller();
      else connectBrowser();
    });

    return () => {
      cancelled = true;
      es?.close();
      local?.stop();
    };
  }, [modeKey, index]);

  /** Current simulation time in epoch seconds. */
  const clock = () => {
    const s = statusRef.current;
    if (s.live || s.clockTs === 0) return Date.now() / 1000;
    if (s.ended) return s.clockTs;
    return s.clockTs + ((performance.now() - s.wallAt) / 1000) * s.speed;
  };

  return { statesRef, trains, feeds, status, clock };
}
