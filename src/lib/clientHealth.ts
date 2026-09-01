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

function post(base: string, message: string) {
  if (sent >= MAX_PER_SESSION || !message) return;
  sent++;
  try {
    const body = JSON.stringify({ message: message.slice(0, 200) });
    // keepalive so a report survives the page being closed by whatever just went wrong.
    void fetch(`${base.replace(/\/$/, "")}/client-error`, {
      method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true,
    }).catch(() => {});
  } catch { /* never let reporting a failure cause one */ }
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
}

/** The map is the one thing whose failure a rider would notice immediately. */
export function reportMapFailure(pollerBase: string | null | undefined, err: unknown) {
  if (!pollerBase) return;
  const m = err instanceof Error ? err.message : String(err);
  post(pollerBase, `map: ${m}`);
}
