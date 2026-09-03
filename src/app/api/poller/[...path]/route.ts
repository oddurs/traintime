import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

const POLLER = process.env.POLLER_URL ?? "http://localhost:7118";

/** Proxies /api/poller/* to the poller service so the browser talks to one origin. Streams SSE through. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const url = `${POLLER}/${path.join("/")}${req.nextUrl.search}`;
  try {
    const upstream = await fetch(url, { cache: "no-store", signal: req.signal });
    const headers = new Headers({ "cache-control": "no-store" });
    const ct = upstream.headers.get("content-type") ?? "application/json";
    headers.set("content-type", ct);
    if (ct.startsWith("text/event-stream")) {
      headers.set("connection", "keep-alive");
      headers.set("x-accel-buffering", "no");
    }
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch (e) {
    if (req.signal.aborted) return new Response(null, { status: 499 });
    return Response.json({ error: `poller offline (${e instanceof Error ? e.message : e})` }, { status: 503 });
  }
}

/**
 * The same proxy for the two things a browser posts: what went wrong, and how long it took.
 *
 * The deployed site is a static export served by a plain file server, so it has no proxy at all —
 * there NEXT_PUBLIC_POLLER_URL points the browser straight at the poller, which sends CORS headers
 * for exactly this. That left `next dev` as the one place these reports could not be delivered:
 * they arrived here and got a 405, so the beacon could never be tried locally, which is how it
 * would have stayed broken without anybody noticing.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  // Small and bounded, like the endpoints behind it: these carry a short message or a handful of
  // numbers, and nothing here should become a way to push a large body at the poller.
  const body = (await req.text()).slice(0, 4096);
  try {
    const upstream = await fetch(`${POLLER}/${path.join("/")}`, {
      method: "POST", headers: { "content-type": "application/json" }, body, signal: req.signal,
    });
    return new Response(upstream.body, { status: upstream.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  } catch (e) {
    if (req.signal.aborted) return new Response(null, { status: 499 });
    return Response.json({ error: `poller offline (${e instanceof Error ? e.message : e})` }, { status: 503 });
  }
}
