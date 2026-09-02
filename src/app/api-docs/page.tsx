import type { Metadata } from "next";
import { BASE_PATH } from "@/lib/basePath";

export const metadata: Metadata = {
  title: "traintime API",
  description: "Live and recorded NYC subway train state over JSON and server-sent events.",
};

export default function ApiDocs() {
  return (
    <div className="doc">
      <a className="back" href={`${BASE_PATH}/`}>← back to the map</a>
      <header>
        <h1>traintime API</h1>
        <p>
          The poller serves everything the map uses: the live state of every train, a stream of changes,
          and a replay of any recorded window. Responses are JSON; streams are server-sent events. CORS is
          open, so a browser can call it directly.
        </p>
      </header>

      <h2>Endpoints</h2>
      <table>
        <thead><tr><th>path</th><th>returns</th></tr></thead>
        <tbody>
          <tr><td><code>GET /state</code></td><td>Every tracked train right now.</td></tr>
          <tr><td><code>GET /stream</code></td><td>SSE. A <code>snapshot</code> event each minute, a <code>delta</code> on every fresh feed tick.</td></tr>
          <tr><td><code>GET /replay?from=&amp;to=&amp;speed=</code></td><td>SSE. The same events, replayed from recordings at <code>speed</code>× real time.</td></tr>
          <tr><td><code>GET /density?from=&amp;to=&amp;buckets=</code></td><td>Arrivals per time bucket — the shape of the service day.</td></tr>
          <tr><td><code>GET /lines?from=&amp;to=</code></td><td>Per route: arrivals, median and 90th-percentile headway, median dwell.</td></tr>
          <tr><td><code>GET /recordings</code></td><td>The window of history on disk.</td></tr>
          <tr><td><code>GET /timing</code></td><td>Which learned tables and model are loaded.</td></tr>
          <tr><td><code>GET /health</code>, <code>/metrics</code></td><td>Liveness and counters.</td></tr>
        </tbody>
      </table>

      <h2>A train</h2>
      <p>Each train in <code>snapshot.trains</code> and <code>delta.trains</code> looks like this:</p>
      <pre>{`{
  "id": "129200_3..N01R",          // GTFS trip id
  "route": "3",
  "direction": "N",
  "trainId": "03 2132 NLT/148",    // MTA's own train identity
  "phase": "moving",               // moving | dwelling | unstarted
  "prevStop": "127N",              // where it left
  "nextStop": "125N",              // where it is going
  "destination": "301N",           // terminal for the rest of this run
  "departedAt": 1788141234,
  "departedEstimated": false,      // true when we modelled the departure
  "prevInferred": false,           // true when we guessed where it came from
  "eta": 1788141480,               // our corrected arrival
  "etaRaw": 1788141495,            // what the MTA predicted
  "sigma": 24,                     // 1σ on eta, seconds
  "runTime": 186,                  // typical time for this stretch
  "leaderId": "129000_3..N01R",    // the train ahead, if any
  "track": "3",
  "stops": [ { "id": "125N", "eta": …, "etaRaw": …, "sigma": … } ]
}`}</pre>
      <p>
        Positions are not in the payload: they are integrated on the client from these fields, so any
        consumer can draw motion at its own frame rate. The maths lives in <code>src/lib/kinematics.ts</code>.
      </p>

      <h2>Client</h2>
      <p>The site&rsquo;s own typed client is <code>src/lib/client.ts</code>:</p>
      <pre>{`import { TrainTimeClient } from "@/lib/client";

const tt = new TrainTimeClient("https://your-poller.example.com");

const { trains } = await tt.state();

const stop = tt.stream((msg) => {
  if (msg.kind === "snapshot") console.log(msg.data.trains.length, "trains");
  if (msg.kind === "delta") console.log(msg.data.trains.length, "changed");
});`}</pre>

      <h2>Run your own</h2>
      <pre>{`git clone https://github.com/oddurs/traintime
npm install
npm run build:network   # MTA static GTFS -> track geometry
npm run dev             # site on :7117, poller on :7118`}</pre>
      <p>
        The poller needs no API key — the MTA&rsquo;s realtime feeds are open. It records to Parquet as it runs,
        and <code>npm run learn</code> turns that history into better predictions.
      </p>

      <p className="muted">
        The interface is built from a published set of tokens and components — the trunk colours,
        the roundels, the controls — drawn at <a href={`${BASE_PATH}/design/`}>/design</a>.
      </p>
      <p className="muted">
        Source and licence: <a href="https://github.com/oddurs/traintime">github.com/oddurs/traintime</a>.
        Data © MTA, used under their open data terms.
      </p>
    </div>
  );
}
