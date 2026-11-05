import type { NextConfig } from "next";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The page loads MapLibre from /maplibre/<version>/ — see src/lib/maplibre.ts.
const maplibreVersion = (JSON.parse(readFileSync(join(process.cwd(), "node_modules/maplibre-gl/package.json"), "utf8")) as { version: string }).version;

// STATIC_EXPORT=1 builds the standalone site for GitHub Pages (in-browser tracking, no poller).
const isStatic = process.env.STATIC_EXPORT === "1";
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || undefined;

const nextConfig: NextConfig = {
  output: isStatic ? "export" : undefined,
  basePath,
  images: { unoptimized: true },
  trailingSlash: isStatic,
  env: { NEXT_PUBLIC_MAPLIBRE_VERSION: maplibreVersion },
};

export default nextConfig;
