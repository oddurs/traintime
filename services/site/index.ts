/**
 * Serves the built site.
 *
 * A separate process from the poller on purpose. The poller records the feeds continuously and
 * its recordings are the product; restarting it to ship a stylesheet would cost a gap in the
 * history and a warm-up every time. Two services, deployed independently.
 *
 * Usage: npx tsx services/site/index.ts   (expects `npm run build:site` to have produced ./out)
 */
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, normalize, extname } from "node:path";
import { gzipSync, brotliCompressSync } from "node:zlib";

const ROOT = join(import.meta.dirname, "..", "..", "out");
const PORT = Number(process.env.PORT ?? 8080);

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
  ".proto": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
};
/** Worth compressing; images and fonts already are. */
const COMPRESSIBLE = /\.(html|js|mjs|css|json|svg|webmanifest|proto|txt)$/;

/**
 * Compressed once, on first request, and kept. The site is a few dozen small files and the
 * process is long-lived, so paying for compression per request would be silly — and the network
 * index is 444 KB raw against 100 KB gzipped, which is the difference between a usable cold load
 * and an unusable one.
 */
const cache = new Map<string, { body: Buffer; type: string; encoding?: string }>();

function resolve(urlPath: string): string | null {
  // Normalise away any attempt to climb out of the site directory.
  const clean = normalize(decodeURIComponent(urlPath.split("?")[0])).replace(/^(\.\.[/\\])+/, "");
  let file = join(ROOT, clean);
  if (!file.startsWith(ROOT)) return null;
  try { if (statSync(file).isDirectory()) file = join(file, "index.html"); } catch { /* try the alternatives */ }
  if (existsSync(file) && statSync(file).isFile()) return file;
  // Next's static export writes /accuracy as accuracy.html.
  if (existsSync(`${file}.html`)) return `${file}.html`;
  return null;
}

const server = createServer((req, res) => {
  // Railway health-checks every service at the same path, and a 404 there fails the deploy.
  if ((req.url ?? "").split("?")[0] === "/health") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify({ ok: existsSync(join(ROOT, "index.html")), serving: ROOT }));
  }
  const accepts = String(req.headers["accept-encoding"] ?? "");
  const path = req.url ?? "/";
  const file = resolve(path) ?? resolve("/404") ?? join(ROOT, "index.html");
  const key = `${file}|${accepts.includes("br") ? "br" : accepts.includes("gzip") ? "gzip" : "id"}`;

  let hit = cache.get(key);
  if (!hit) {
    let body: Buffer;
    try { body = readFileSync(file); } catch { res.writeHead(404, { "content-type": "text/plain" }); return res.end("not found"); }
    const type = TYPES[extname(file)] ?? "application/octet-stream";
    if (COMPRESSIBLE.test(file) && accepts.includes("br")) hit = { body: brotliCompressSync(body), type, encoding: "br" };
    else if (COMPRESSIBLE.test(file) && accepts.includes("gzip")) hit = { body: gzipSync(body), type, encoding: "gzip" };
    else hit = { body, type };
    cache.set(key, hit);
  }

  res.writeHead(200, {
    "content-type": hit.type,
    ...(hit.encoding ? { "content-encoding": hit.encoding } : {}),
    // Hashed asset names may be cached forever; everything else has to be revalidated or a
    // deploy would never reach anybody.
    "cache-control": /\/_next\/static\//.test(file) ? "public, max-age=31536000, immutable" : "public, max-age=0, must-revalidate",
    vary: "accept-encoding",
    "x-content-type-options": "nosniff",
  });
  res.end(req.method === "HEAD" ? undefined : hit.body);
});

server.listen(PORT, () => console.log(`site on :${PORT} from ${ROOT}`));
