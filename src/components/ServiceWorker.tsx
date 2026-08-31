"use client";

import { useEffect } from "react";
import { asset } from "@/lib/basePath";

/** Registers the offline shell. No-op where service workers are unavailable. */
export default function ServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;
    const url = asset("/sw.js");
    navigator.serviceWorker.register(url, { scope: asset("/") }).catch(() => {});
  }, []);
  return null;
}
