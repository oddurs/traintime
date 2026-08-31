/**
 * Per-feed health. The MTA's feeds fail in three different ways and only one of them is
 * obvious: an HTTP error is loud, a decode error is loud, but a feed whose header timestamp
 * stops advancing keeps returning 200 with stale contents — which is the dangerous one,
 * because everything downstream looks fine while the trains quietly stop moving.
 */
export interface FeedHealth {
  id: string;
  cadence: number;
  ok: boolean;
  lastOkAt?: number;
  lastHeaderTs?: number;
  lastHeaderChangeAt?: number;
  consecutiveErrors: number;
  lastError?: string;
  lastMs: number;
  fetches: number;
  errors: number;
  stalled: boolean;
  /** True while the breaker is open and we are polling slowly to let the feed recover. */
  backingOff: boolean;
}

const MAX_BACKOFF_MS = 60_000;
const BREAKER_AFTER = 8;

export class FeedMonitor {
  private feeds = new Map<string, FeedHealth>();

  constructor(defs: { id: string; cadence: number }[]) {
    for (const d of defs) {
      this.feeds.set(d.id, {
        id: d.id, cadence: d.cadence, ok: false, consecutiveErrors: 0,
        lastMs: 0, fetches: 0, errors: 0, stalled: false, backingOff: false,
      });
    }
  }

  get(id: string): FeedHealth {
    return this.feeds.get(id)!;
  }

  succeeded(id: string, headerTs: number, ms: number, now: number) {
    const f = this.get(id);
    f.fetches++;
    f.ok = true;
    f.lastOkAt = now;
    f.lastMs = ms;
    f.consecutiveErrors = 0;
    f.backingOff = false;
    f.lastError = undefined;
    if (headerTs !== f.lastHeaderTs) {
      f.lastHeaderTs = headerTs;
      f.lastHeaderChangeAt = now;
    }
    f.stalled = this.isStalled(f, now);
  }

  failed(id: string, error: string, ms: number, now: number) {
    const f = this.get(id);
    f.fetches++;
    f.errors++;
    f.ok = false;
    f.lastMs = ms;
    f.lastError = error;
    f.consecutiveErrors++;
    f.backingOff = f.consecutiveErrors >= BREAKER_AFTER;
    void now;
  }

  private isStalled(f: FeedHealth, now: number): boolean {
    if (f.lastHeaderChangeAt === undefined) return false;
    return now - f.lastHeaderChangeAt > Math.max(90, f.cadence * 6);
  }

  /** How long to wait before the next attempt: the feed's cadence, or a backoff after errors. */
  nextDelayMs(id: string, lastMs: number): number {
    const f = this.get(id);
    if (f.consecutiveErrors === 0) return Math.max(1000, f.cadence * 1000 - lastMs + 500);
    const exp = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(f.consecutiveErrors, 6));
    // Jitter so a shared outage does not turn into a synchronised retry storm.
    return Math.round(exp * (0.75 + Math.random() * 0.5));
  }

  snapshot(now: number): FeedHealth[] {
    const out: FeedHealth[] = [];
    for (const f of this.feeds.values()) {
      f.stalled = this.isStalled(f, now);
      out.push({ ...f });
    }
    return out;
  }

  /** Data is trustworthy when most feeds are current; one sick line should not read as fine. */
  summary(now: number) {
    const all = this.snapshot(now);
    const healthy = all.filter((f) => f.ok && !f.stalled);
    return {
      healthy: healthy.length,
      total: all.length,
      degraded: all.filter((f) => !f.ok || f.stalled).map((f) => ({
        id: f.id,
        why: !f.ok ? (f.lastError ?? "error") : "stalled",
        errors: f.consecutiveErrors,
      })),
    };
  }
}
