"use client";

import protobuf from "protobufjs";
import type { GbmModel, Network, StateDelta, StateSnapshot, TimingTables } from "./types";
import { NetworkIndex } from "./network";
import { Timing } from "./timing";
import { Tracker } from "./tracker";
import { FEEDS, fetchFeed, makeDecoder, type Decoder } from "./feed";
import { asset } from "./basePath";

export type SourceMessage =
  | { kind: "snapshot"; data: StateSnapshot }
  | { kind: "delta"; data: StateDelta }
  | { kind: "timing"; model: boolean };

/**
 * Runs the whole pipeline in the browser: fetches the MTA feeds directly (their CORS policy
 * allows it), decodes, tracks, and emits the same snapshots/deltas the poller would stream.
 * Used when no poller is reachable — e.g. the static GitHub Pages deployment. Timing tables and
 * the residual model come from the snapshot files under /data.
 */
export class BrowserSource {
  private tracker!: Tracker;
  private decoder!: Decoder;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private stopped = false;
  private lastSnapshotAt = 0;
  timing!: Timing;

  constructor(private readonly net: NetworkIndex | Network, private readonly onMessage: (m: SourceMessage) => void) {}

  /**
   * Start tracking as soon as the small files land: the schema and the learned tables are a few
   * hundred KB, so trains appear within a second or two. The residual model is an order of
   * magnitude larger, so it loads in the background and is swapped in when it arrives.
   */
  async start() {
    const index = this.net instanceof NetworkIndex ? this.net : new NetworkIndex(this.net);
    const [protoText, tables] = await Promise.all([
      fetch(asset("/data/nyct-subway.proto")).then((r) => r.text()),
      fetch(asset("/data/timing.json")).then((r) => (r.ok ? (r.json() as Promise<TimingTables>) : null)).catch(() => null),
    ]);
    const root = protobuf.parse(protoText).root;
    this.decoder = makeDecoder(root.lookupType("transit_realtime.FeedMessage"));
    this.timing = new Timing(index, tables, null);
    this.tracker = new Tracker(index, this.timing);
    if (this.stopped) return;
    for (const [i, f] of FEEDS.entries()) this.timers.push(setTimeout(() => this.poll(f), i * 250));
    this.timers.push(setInterval(() => this.tracker.expire(Math.floor(Date.now() / 1000)), 30_000) as unknown as ReturnType<typeof setTimeout>);

    fetch(asset("/data/eta-model.json"))
      .then((r) => (r.ok ? (r.json() as Promise<GbmModel>) : null))
      .then((model) => {
        if (this.stopped || !model) return;
        this.timing.model = model;
        this.onMessage({ kind: "timing", model: true });
      })
      .catch(() => {});
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers) { clearTimeout(t); clearInterval(t as unknown as ReturnType<typeof setInterval>); }
    this.timers = [];
  }

  private async poll(feed: { id: string; cadence: number }) {
    if (this.stopped) return;
    const fetchedAt = Math.floor(Date.now() / 1000);
    const r = await fetchFeed(feed.id);
    if (this.stopped) return;
    if (!r.buf) {
      this.tracker.feeds.set(feed.id, { id: feed.id, ok: false, error: r.error, ms: r.ms });
    } else {
      try {
        const d = this.decoder(r.buf);
        this.tracker.feeds.set(feed.id, { id: feed.id, ok: true, timestamp: d.ts, ms: r.ms });
        const { fresh } = this.tracker.ingest({ feed: feed.id, ts: d.ts, fetchedAt, trains: d.trains });
        if (fresh) this.emit();
      } catch (e) {
        this.tracker.feeds.set(feed.id, { id: feed.id, ok: false, error: `decode: ${e instanceof Error ? e.message : e}`, ms: r.ms });
      }
    }
    this.timers.push(setTimeout(() => this.poll(feed), Math.max(1000, feed.cadence * 1000 - r.ms + 500)));
  }

  private emit() {
    const now = Math.floor(Date.now() / 1000);
    if (now - this.lastSnapshotAt >= 60) {
      this.lastSnapshotAt = now;
      this.onMessage({ kind: "snapshot", data: this.tracker.snapshot(now) });
    } else {
      const d = this.tracker.delta(now);
      if (d.trains.length || d.removed.length) this.onMessage({ kind: "delta", data: d });
    }
  }
}
