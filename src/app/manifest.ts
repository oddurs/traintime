import type { MetadataRoute } from "next";
import { CHROME_COLOR } from "@/lib/palette";
import { BRAND_NAME, BRAND_TAGLINE } from "@/lib/brand";

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

export const dynamic = "force-static";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: `${BRAND_NAME} — ${BRAND_TAGLINE}`,
    short_name: BRAND_NAME,
    description: "Every New York City subway train, moving on a map, simulated from the MTA's realtime feeds.",
    start_url: `${BASE}/`,
    scope: `${BASE}/`,
    display: "standalone",
    orientation: "any",
    background_color: CHROME_COLOR,
    theme_color: CHROME_COLOR,
    categories: ["travel", "navigation", "utilities"],
    icons: [
      { src: `${BASE}/icon-192.png`, sizes: "192x192", type: "image/png", purpose: "any" },
      { src: `${BASE}/icon-512.png`, sizes: "512x512", type: "image/png", purpose: "any" },
      { src: `${BASE}/icon-maskable.png`, sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
