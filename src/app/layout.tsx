import type { Metadata, Viewport } from "next";
import { CHROME_COLOR } from "@/lib/palette";
import ServiceWorker from "@/components/ServiceWorker";
import { BASE_PATH } from "@/lib/basePath";
import "./globals.css";

const title = "traintime — NYC subway, live";
const description = "Every New York City subway train, moving on a map, simulated from the MTA's realtime feeds and measured against what the trains actually did.";

export const metadata: Metadata = {
  title: { default: title, template: "%s · traintime" },
  description,
  applicationName: "traintime",
  metadataBase: new URL("https://traintime-site-production.up.railway.app"),
  icons: {
    icon: [
      { url: `${BASE_PATH}/icon-192.png`, sizes: "192x192", type: "image/png" },
      { url: `${BASE_PATH}/icon-512.png`, sizes: "512x512", type: "image/png" },
    ],
    apple: `${BASE_PATH}/apple-icon.png`,
  },
  appleWebApp: { capable: true, title: "traintime", statusBarStyle: "black-translucent" },
  openGraph: { title, description, type: "website", siteName: "traintime" },
  twitter: { card: "summary_large_image", title, description },
};

export const viewport: Viewport = {
  themeColor: CHROME_COLOR,
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/*
          * The board's half of the network, asked for before the JavaScript that asks for it.
          *
          * It is the last thing on the critical path and the only one a rider is actually waiting
          * for: measured cold on a slow connection, the page became readable at 7.5 seconds and
          * this file landed at 7.4 — the request had not been made until the bundle had downloaded,
          * parsed and run. A preload starts it with everything else.
          */}
        <link rel="preload" as="fetch" type="application/json" crossOrigin="anonymous" href={`${BASE_PATH}/data/network-lite.json`} />
        <link rel="preconnect" href="https://tiles.openfreemap.org" />
      </head>
      <body>
        {children}
        <ServiceWorker />
      </body>
    </html>
  );
}
