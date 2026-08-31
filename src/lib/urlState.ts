/**
 * The whole app state lives in the URL hash, so every view is a link:
 *   #s=A24            a station board
 *   #t=<trip id>      a followed train
 *   #r=A,C,E          visible routes (absent = all)
 *   #@=40.75,-73.98,13  camera
 *   #replay=from,to,speed
 */
export interface UrlState {
  station?: string;
  /** Where the journey ends, when a board has been turned into a trip. */
  to?: string;
  train?: string;
  routes?: string[];
  view?: { lat: number; lon: number; zoom: number };
  replay?: { from: number; to: number; speed: number };
}

export function parseHash(hash: string): UrlState {
  const s: UrlState = {};
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const station = params.get("s");
  if (station) s.station = station;
  const train = params.get("t");
  if (train) s.train = train;
  const to = params.get("to");
  if (to) s.to = to;
  const routes = params.get("r");
  if (routes) s.routes = routes.split(",").filter(Boolean);
  const view = params.get("@");
  if (view) {
    const [lat, lon, zoom] = view.split(",").map(Number);
    if ([lat, lon, zoom].every(Number.isFinite)) s.view = { lat, lon, zoom };
  }
  const replay = params.get("replay");
  if (replay) {
    const [from, to, speed] = replay.split(",").map(Number);
    if ([from, to, speed].every(Number.isFinite)) s.replay = { from, to, speed };
  }
  return s;
}

export function toHash(s: UrlState): string {
  const p = new URLSearchParams();
  if (s.station) p.set("s", s.station);
  if (s.train) p.set("t", s.train);
  if (s.to) p.set("to", s.to);
  if (s.routes) p.set("r", s.routes.join(","));
  if (s.view) p.set("@", `${s.view.lat.toFixed(4)},${s.view.lon.toFixed(4)},${s.view.zoom.toFixed(1)}`);
  if (s.replay) p.set("replay", `${s.replay.from},${s.replay.to},${s.replay.speed}`);
  const str = p.toString().replace(/%2C/g, ",").replace(/%40/g, "@");
  return str ? `#${str}` : "";
}

export function readHash(): UrlState {
  return typeof window === "undefined" ? {} : parseHash(window.location.hash);
}

/** Replace the hash without adding history entries (the map moves constantly). */
export function writeHash(s: UrlState) {
  if (typeof window === "undefined") return;
  const next = toHash(s);
  const url = `${window.location.pathname}${window.location.search}${next}`;
  if (window.location.hash !== next) window.history.replaceState(null, "", url);
}
