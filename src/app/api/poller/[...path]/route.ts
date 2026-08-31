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
