import { defineRailway, preserve, project, service, volume } from "railway/iac";

/**
 * The project, in code.
 *
 * Pulled from what Railway is actually running rather than translated from railway.json, because
 * the translation was lossy: it knew only about the linked service, and dropped the builder, the
 * watch patterns and the restart policy on the way. What is written out here was verified against
 * the live project with `railway config plan` before railway.json was removed.
 *
 * Both services are built from a Dockerfile chosen by RAILWAY_DOCKERFILE_PATH — one image for the
 * poller, one for the site — so the two differ by an environment variable rather than by a file.
 * Secrets and URLs stay in Railway; `preserve()` says "this variable exists, do not manage its
 * value from here".
 */

/*
 * Two things railway.json used to carry are deliberately not here: the builder and the restart
 * policy. Railway derives the builder from the Dockerfile each service points at, and ON_FAILURE
 * is already its default, so it records neither — set them and every `railway config plan` shows
 * the same phantom diff for ever, which is how a plan stops being read.
 */

/**
 * What a change has to touch before either service is rebuilt.
 *
 * Without this every commit redeploys both images, including the ones that only move a comment.
 * The site is rebuilt by anything a browser receives; the poller by the service code, the shared
 * library, and the data files baked into its image.
 */
const WATCH = [
  "services/**",
  "src/**",
  "public/**",
  "Dockerfile",
  "Dockerfile.site",
  "package.json",
  "package-lock.json",
];

export default defineRailway(() => {
  const traintimeVolume = volume("traintime-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "us-west2", sizeMB: 5000 });
  const traintimeSite = service("traintime-site", {
    replicas: { "us-west2": 1 },
    env: { POLLER_URL: preserve(), RAILWAY_DOCKERFILE_PATH: preserve() },
    healthcheck: "/health",
    healthcheckTimeout: 30,
    build: { watchPatterns: WATCH },
  });
  const traintime = service("traintime", {
    replicas: { "us-west2": 1 },
    volumeMounts: { "/data": traintimeVolume },
    env: { RAILWAY_DOCKERFILE_PATH: preserve() },
    healthcheck: "/health",
    healthcheckTimeout: 30,
    build: { watchPatterns: WATCH },
  });

  return project("courteous-radiance", {
    resources: [traintimeSite, traintime, traintimeVolume],
  });
});
