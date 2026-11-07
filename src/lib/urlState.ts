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

const urlFor = (s: UrlState) => `${window.location.pathname}${window.location.search}${toHash(s)}`;

/**
 * Replace the hash without adding a history entry — the camera moves constantly, and a filter is
 * not a place you go back to. The entry's own state is kept, because it records how deep into the
 * app this entry is (see `openPlace`).
 */
export function writeHash(s: UrlState) {
  if (typeof window === "undefined") return;
  if (window.location.hash !== toHash(s)) window.history.replaceState(window.history.state, "", urlFor(s));
}

/**
 * How many places deep this history entry is: 0 at the map, one more for each station or train
 * opened on top of it. Kept in the entry's state, so it survives a reload and a back gesture.
 */
export function placeDepth(): number {
  if (typeof window === "undefined") return 0;
  const d = (window.history.state as { tt?: unknown } | null)?.tt;
  return typeof d === "number" ? d : 0;
}

/**
 * Opening a station or a train is going somewhere, so it is a history entry: the phone's back
 * gesture, the browser's back button and Android's back key all close it again, as they would in
 * an app. Every selection used to replace the entry, so "back" left the site entirely.
 */
export function openPlace(s: UrlState) {
  if (typeof window === "undefined") return;
  window.history.pushState({ tt: placeDepth() + 1 }, "", urlFor(s));
}

/**
 * Closing a place goes back to where it was opened from, rather than writing a new entry over it —
 * otherwise the stack fills with copies of the map and back has to be pressed twice. Returns false
 * when there is nothing of ours to go back to (the page was opened on a station by a link), and
 * the caller closes it in place instead.
 */
export function closePlace(): boolean {
  if (typeof window === "undefined" || placeDepth() === 0) return false;
  window.history.back();
  return true;
}
