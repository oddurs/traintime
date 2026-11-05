/**
 * The live stream is compressed and flushed per event, and a client that stops reading is let go.
 * Driven over a real socket, because a compressor that holds an event back looks exactly like a
 * working one until you wait for the event.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { get, type IncomingMessage } from "node:http";
import { createGunzip, gunzipSync } from "node:zlib";
import type { ServerResponse } from "node:http";
import { EventStream, PollerServer } from "../services/poller/server";

// A payload shaped like the real one: hundreds of trains, each with its remaining stops.
const trains = Array.from({ length: 400 }, (_, i) => ({
  id: `0${i}_1..S`, route: "1", direction: "S", phase: "moving",
  stops: Array.from({ length: 20 }, (_, j) => ({ id: `1${j}S`, eta: 1_793_900_000 + j * 90, sigma: 8 })),
}));
const tracker = {
  snapshot: () => ({ ts: 1_793_900_000, live: true, feeds: [], trains }),
  delta: () => ({ ts: 1_793_900_030, trains: trains.slice(0, 5), removed: [] }),
};

async function serve() {
  const server = new PollerServer({ tracker } as unknown as ConstructorParameters<typeof PollerServer>[0]);
  const http = server.listen(0);
  await new Promise((r) => http.once("listening", r));
  const { port } = http.address() as { port: number };
  return { server, http, at: `http://127.0.0.1:${port}` };
}

/** Read an event stream until `want` has arrived; the connection stays open throughout. */
function firstEvents(url: string, gzip: boolean, want: number): Promise<{ encoding?: string; events: string[] }> {
  return new Promise((resolve, reject) => {
    const req = get(url, { headers: gzip ? { "accept-encoding": "gzip" } : {} }, (res: IncomingMessage) => {
      const body = res.headers["content-encoding"] === "gzip" ? res.pipe(createGunzip()) : res;
      let text = "";
      body.on("data", (d: Buffer) => {
        text += d.toString();
        const events = [...text.matchAll(/event: (\w+)\n/g)].map((m) => m[1]);
        if (events.length >= want) {
          req.destroy();
          resolve({ encoding: res.headers["content-encoding"], events });
        }
      });
    });
    req.on("error", (e) => (e.message.includes("aborted") || e.message.includes("socket hang up") ? undefined : reject(e)));
    setTimeout(() => {
      req.destroy();
      reject(new Error("no event arrived: something is holding it back"));
    }, 3000).unref();
  });
}

test("a gzip client gets the snapshot while the stream is still open, and then each delta", async () => {
  const { server, http, at } = await serve();
  try {
    const pending = firstEvents(`${at}/stream`, true, 3);
    await new Promise((r) => setTimeout(r, 100));
    // The server's first broadcast is always a full snapshot; the next, inside the minute, a delta.
    server.broadcast(1_793_900_030);
    server.broadcast(1_793_900_060);
    const { encoding, events } = await pending;
    assert.equal(encoding, "gzip");
    assert.deepEqual(events, ["snapshot", "snapshot", "delta"]);
  } finally {
    http.close();
  }
});

test("a client that does not ask for gzip gets plain text", async () => {
  const { http, at } = await serve();
  try {
    const { encoding, events } = await firstEvents(`${at}/stream`, false, 1);
    assert.equal(encoding, undefined);
    assert.deepEqual(events, ["snapshot"]);
  } finally {
    http.close();
  }
});

test("/state is gzipped for clients that accept it, and is the same JSON", async () => {
  const { http, at } = await serve();
  try {
    const res = await new Promise<IncomingMessage>((r) => get(`${at}/state`, { headers: { "accept-encoding": "gzip" } }, r));
    const parts: Buffer[] = [];
    for await (const p of res) parts.push(p as Buffer);
    const raw = Buffer.concat(parts);
    assert.equal(res.headers["content-encoding"], "gzip");
    const plain = JSON.stringify(tracker.snapshot());
    assert.equal(gunzipSync(raw).toString(), plain);
    assert.ok(raw.length * 5 < plain.length, `${raw.length} bytes gzipped from ${plain.length}`);
  } finally {
    http.close();
  }
});

test("a client that has stopped reading is ended rather than buffered for", () => {
  let ended = false;
  const res = {
    writeHead() {}, on() {}, write() { return true; },
    end() { ended = true; },
    writableLength: EventStream.MAX_BACKLOG + 1,
  } as unknown as ServerResponse;
  const stream = new EventStream(res, false);
  stream.write("event: delta\ndata: {}\n\n");
  assert.equal(ended, true);
  assert.equal(stream.closed, true);
});

test("/lines computes its baseline once an hour, not once a request", async () => {
  let baselineQueries = 0;
  const conn = {
    runAndReadAll: async (sql: string) => ({
      getRowObjectsJS: () => {
        if (sql.includes("AS headway, count(*) AS n")) {
          baselineQueries++;
          return [{ route: "A", headway: 300, n: 50 }];
        }
        return [{ route: "A", arrivals: 10, headway_p50: 600, headway_p90: 900, dwell_p50: 30 }];
      },
    }),
  };
  const server = new PollerServer({ tracker, conn: () => conn } as unknown as ConstructorParameters<typeof PollerServer>[0]);
  const http = server.listen(0);
  await new Promise((r) => http.once("listening", r));
  const { port } = http.address() as { port: number };
  const lines = async (to: number) => (await (await fetch(`http://127.0.0.1:${port}/lines?to=${to}`)).json()) as { lines: { headwayUsual: number; headwayRatio: number }[] };
  try {
    const t = 1_793_901_000;
    const first = await lines(t);
    await lines(t + 60);
    await lines(t + 120);
    assert.equal(baselineQueries, 1);
    assert.equal(first.lines[0].headwayUsual, 300);
    assert.equal(first.lines[0].headwayRatio, 2);
    // A window that reaches into another hour leaves out a different hour, so it is its own baseline.
    await lines(t + 3600);
    assert.equal(baselineQueries, 2);
  } finally {
    http.close();
  }
});
