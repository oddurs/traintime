import type { Metadata, Viewport } from "next";
import ServiceWorker from "@/components/ServiceWorker";
import { BASE_PATH } from "@/lib/basePath";
import "./globals.css";

const title = "traintime — NYC subway, live";
const description = "Every New York City subway train, moving on a map, simulated from the MTA's realtime feeds and measured against what the trains actually did.";

export const metadata: Metadata = {
  title: { default: title, template: "%s · traintime" },
  description,
  applicationName: "traintime",
  metadataBase: new URL("https://oddurs.github.io"),
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
  themeColor: "#0b0b0d",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <ServiceWorker />
      </body>
    </html>
  );
}
