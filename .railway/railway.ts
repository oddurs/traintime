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
 *
 * Plan and apply with the CLI — `railway config plan` — and not with `npx railway`. The IaC engine
 * moved into the CLI at 5.42.1; the `railway` npm package stops at 3.11.0 and answers that command
 * with "upgrade the CLI", which is confusing when the installed CLI is already newer. It is kept as
 * a devDependency for one reason: the `railway/iac` types below, which are what make this file
 * worth typechecking. Everything that talks to Railway goes through the CLI.
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
  // The site build *is* a script: build-pages.sh sets the export up, moves the API routes aside
  // and stamps the service worker. A change to it was not a change to the site as far as this
  // list was concerned, and a deploy carrying one was skipped with "no changes detected in watch
  // paths" — which reads exactly like a successful deploy until you check what is live.
  "scripts/**",
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
