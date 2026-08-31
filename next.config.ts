import type { NextConfig } from "next";

// STATIC_EXPORT=1 builds the standalone site for GitHub Pages (in-browser tracking, no poller).
const isStatic = process.env.STATIC_EXPORT === "1";
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || undefined;

const nextConfig: NextConfig = {
  output: isStatic ? "export" : undefined,
  basePath,
  images: { unoptimized: true },
  trailingSlash: isStatic,
};

export default nextConfig;
