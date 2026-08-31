import type { LonLat, Network, Station } from "./types";
import { distM, makePath, type Path } from "./geo";

export const parentOf = (id: string) => id.replace(/[NS]$/, "");

/** Indexed, query-friendly view of network.json shared by server and client. */
export class NetworkIndex {
  private pathCache = new Map<string, Path>();
  private segCache = new Map<string, Path>();
  private mergedPrev: Record<string, string[]> = {};
  /** Diagnostics: how often we had to guess a train's track instead of knowing it. */
  readonly stats = { paths: 0, chained: 0, straightFallback: 0 };

  constructor(public readonly net: Network) {
    for (const m of Object.values(net.prevOf)) {
      for (const [k, v] of Object.entries(m)) {
        this.mergedPrev[k] = [...new Set([...(this.mergedPrev[k] ?? []), ...v])];
      }
    }
  }

  station(id: string): Station | undefined {
    return this.net.stations[parentOf(id)];
  }

  stationName(id: string): string {
    return this.station(id)?.name ?? id;
  }

  routeColor(route: string): string {
    return this.net.routes[route]?.color ?? "#808183";
  }

  /** Candidate previous stops for `nextDir` on `route` (directional ids). */
  prevCandidates(route: string, nextDir: string): string[] {
    return this.net.prevOf[route]?.[nextDir] ?? this.mergedPrev[nextDir] ?? [];
  }

  /** Straight-line metres between two stops. */
  hop(a: string, b: string): number {
    const sa = this.station(a), sb = this.station(b);
    return sa && sb ? distM([sa.lon, sa.lat], [sb.lon, sb.lat]) : Infinity;
  }

  /** Scheduled run time between two stops, if the pair is scheduled consecutively. */
  scheduledRun(prevDir: string, nextDir: string): number | undefined {
    const a = parentOf(prevDir), b = parentOf(nextDir);
    return this.net.schedRun[a < b ? `${a}-${b}` : `${b}-${a}`];
  }

  private segment(a: string, b: string): Path | undefined {
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    const pts = this.net.segments[key];
    if (!pts) return undefined;
    const ck = `${a}-${b}`;
    let p = this.segCache.get(ck);
    if (!p) {
      p = makePath(a < b ? pts : [...pts].reverse());
      this.segCache.set(ck, p);
    }
    return p;
  }

  /** Track geometry from prev to next, chaining through skipped stops if needed. */
  pathBetween(route: string, prevDir: string, nextDir: string): Path {
    const key = `${route}|${prevDir}|${nextDir}`;
    const cached = this.pathCache.get(key);
    if (cached) return cached;
    this.stats.paths++;
    const pa = parentOf(prevDir), pb = parentOf(nextDir);
    let path = this.segment(pa, pb);
    if (!path) {
      this.stats.chained++;
      const chain = this.findChain(route, prevDir, nextDir);
      if (chain) {
        const pts: LonLat[] = [];
        let ok = true;
        for (let i = 0; i + 1 < chain.length; i++) {
          const seg = this.segment(parentOf(chain[i]), parentOf(chain[i + 1]));
          if (!seg) { ok = false; break; }
          pts.push(...(pts.length ? seg.pts.slice(1) : seg.pts));
        }
        if (ok && pts.length >= 2) path = makePath(pts);
      }
    }
    if (!path) {
      this.stats.straightFallback++;
      const a = this.station(pa), b = this.station(pb);
      const pa_: LonLat = a ? [a.lon, a.lat] : [0, 0];
      const pb_: LonLat = b ? [b.lon, b.lat] : pa_;
      path = makePath([pa_, pb_]);
    }
    this.pathCache.set(key, path);
    return path;
  }

  /** Walk backwards from next through the route's predecessor graph looking for prev. */
  private findChain(route: string, prevDir: string, nextDir: string): string[] | undefined {
    const graph = this.net.prevOf[route] ?? this.mergedPrev;
    const back = new Map<string, string>();
    let frontier = [nextDir];
    const visited = new Set(frontier);
    for (let depth = 0; depth < 10 && frontier.length; depth++) {
      const nextFrontier: string[] = [];
      for (const cur of frontier) {
        for (const p of graph[cur] ?? this.mergedPrev[cur] ?? []) {
          if (visited.has(p)) continue;
          visited.add(p);
          back.set(p, cur);
          if (p === prevDir) {
            const chain = [p];
            let c = p;
            while (c !== nextDir) { c = back.get(c)!; chain.push(c); }
            return chain;
          }
          nextFrontier.push(p);
        }
      }
      frontier = nextFrontier;
    }
    return undefined;
  }
}
