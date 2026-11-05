/**
 * Tell the poller when a browser fails.
 *
 * The poller reports its own health every few seconds; the browser reported nothing at all. If
 * the map failed to start for someone, or a style or a font never loaded, we found out only if
 * they told us — and the interaction crawl only ever walks the paths we thought to script.
 *
 * Deliberately minimal: a short message, nothing identifying, a hard cap per session so a broken
 * page cannot become a firehose, and every failure of the reporter itself swallowed. Telemetry
 * that can break the thing it is watching is worse than none.
 */
const MAX_PER_SESSION = 5;
let sent = 0;

/** Post a small JSON body and never care what happens to it. */
function send(base: string, path: string, body: unknown) {
  try {
    // keepalive so a report survives the page being closed by whatever just went wrong.
    void fetch(`${base.replace(/\/$/, "")}${path}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), keepalive: true,
    }).catch(() => {});
  } catch { /* never let reporting a failure cause one */ }
}

function post(base: string, message: string) {
  if (sent >= MAX_PER_SESSION || !message) return;
  sent++;
  send(base, "/client-error", { message: message.slice(0, 200) });
}

/** Install the handlers. Safe to call more than once; only the first takes effect. */
export function reportClientFailures(pollerBase: string | null | undefined) {
  if (!pollerBase || typeof window === "undefined") return;
  const w = window as unknown as { __ttHealth?: boolean };
  if (w.__ttHealth) return;
  w.__ttHealth = true;

  window.addEventListener("error", (e) => {
    // Asset failures arrive as an error on the element rather than a message.
    const el = e.target as HTMLElement | undefined;
    if (el && el !== (window as unknown as HTMLElement) && "tagName" in el) {
      const src = (el as HTMLImageElement | HTMLScriptElement).src || (el as HTMLLinkElement).href || "";
      return post(pollerBase, `failed to load ${el.tagName.toLowerCase()}: ${String(src).slice(0, 120)}`);
    }
    post(pollerBase, e.message || "uncaught error");
  }, true);

  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason as { message?: string } | string | undefined;
    post(pollerBase, typeof r === "string" ? r : r?.message || "unhandled rejection");
  });

  reportTiming(pollerBase);
}

/** The map is the one thing whose failure a rider would notice immediately. */
export function reportMapFailure(pollerBase: string | null | undefined, err: unknown) {
  if (!pollerBase) return;
  const m = err instanceof Error ? err.message : String(err);
  post(pollerBase, `map: ${m}`);
}

/*
 * How long the page took, from inside the page.
 *
 * The weight audit measures this too, but it measures one throttled Chrome on a developer's
 * machine — it cannot say what the app is like on a five-year-old phone on a platform with one
 * bar, which is the condition this app is mostly used in. These are the same two milestones the
 * audit watches for, marked by the app itself rather than inferred by polling the DOM from
 * outside, so the scripted number and the real one describe the same thing.
 */
const marks: Partial<Record<"readable" | "map", number>> = {};
let timingSent = false;

/** Long enough that a slow visit has finished being slow, short enough to still be there to send. */
const REPORT_AFTER_MS = 20_000;

const claimed = new Set<string>();

/**
 * Record that the page reached a milestone. First call wins; later ones are the same milestone
 * being re-rendered, which is not news.
 *
 * Recorded two animation frames late, so that a milestone means the browser got as far as a frame
 * with this on screen rather than only that React put it in the DOM.
 *
 * That is still not the same as first contentful paint, and both are reported without either
 * being corrected by the other: `readable` says when the app had something worth showing, `fcp`
 * says when the browser showed anything at all. On the deployed site they sit close together
 * (313 ms and 420 ms on a fast connection), and a visit where they drift far apart is a visit
 * spent waiting on something render-blocking rather than on the app — which is a different
 * problem with a different fix, and collapsing the two into one number would hide it.
 */
export function markTiming(name: "readable" | "map") {
  if (typeof performance === "undefined" || claimed.has(name)) return;
  claimed.add(name);
  const at = () => {
    marks[name] = Math.round(performance.now());
    // The same moment as a standard mark, so a lab measurement reads exactly what real visits report.
    try { performance.mark(`tt:${name}`); } catch { /* marks are optional; the report above is not */ }
  };
  if (typeof requestAnimationFrame !== "function") return at();
  requestAnimationFrame(() => requestAnimationFrame(at));
}

function paint(name: string): number | undefined {
  try {
    const e = performance.getEntriesByName(name)[0];
    return e ? Math.round(e.startTime) : undefined;
  } catch { return undefined; }
}

/**
 * Send the one timing report this page will send.
 *
 * Sent late — at the point the page is hidden, or after long enough that anything still missing
 * is missing rather than pending. Sending at `readable` would have meant never hearing about the
 * map, and sending twice would have meant weighting the percentiles towards fast visits, which
 * are exactly the ones there is no reason to look at.
 */
function sendTiming(base: string) {
  if (timingSent || typeof performance === "undefined") return;
  timingSent = true;
  const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  // Not in every browser, and not typed anywhere, but the two facts that say most about why a
  // visit was slow: what it was running on, and what it was arriving over.
  const n = navigator as Navigator & { deviceMemory?: number; connection?: { effectiveType?: string } };
  send(base, "/client-timing", {
    ttfb: nav ? Math.round(nav.responseStart) : undefined,
    fcp: paint("first-contentful-paint"),
    readable: marks.readable,
    map: marks.map,
    cpu: n.hardwareConcurrency,
    mem: n.deviceMemory,
    net: n.connection?.effectiveType,
  });
}

/** Arrange for that one report to happen, whichever way the visit ends. */
function reportTiming(base: string) {
  const fire = () => sendTiming(base);
  // `pagehide` is the one that fires on mobile Safari, where `unload` does not.
  window.addEventListener("pagehide", fire);
  document.addEventListener("visibilitychange", () => { if (document.hidden) fire(); });
  // And a backstop, so a tab left open all day is still counted — including, importantly, one
  // where the map never loaded and nothing else was ever going to trigger a report.
  window.setTimeout(fire, REPORT_AFTER_MS);
}
