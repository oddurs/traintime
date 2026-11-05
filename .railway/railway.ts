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
 * The builder is deliberately not here: Railway derives it from the Dockerfile each service points
 * at and records nothing, so setting it makes every `railway config plan` show the same phantom
 * diff for ever, which is how a plan stops being read.
 *
 * The poller's restart policy is here, and is ALWAYS rather than the default ON_FAILURE. ON_FAILURE
 * gives up after ten restarts per deployment, and a crash once a night spends ten in under a
 * fortnight: on 2026-10-27 it spent the last one and the poller recorded nothing for nine days
 * while reporting CRASHED to nobody. Unlimited restarts need the Pro plan.
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

/**
 * Where the poller and its volume live. They have to be the same place: a volume is attached in
 * one region, and a service asked to run somewhere else migrates its volume there on deploy.
 *
 * Both moved here from us-west2 with the 2026-10-14 deploy, and this file went on saying us-west2.
 * The plan then showed only the volume half of that diff, so `config apply` would have
 * migrated five gigabytes of recordings back across the country as a side effect.
 */
const POLLER_REGION = "us-east4-eqdc4a";

export default defineRailway(() => {
  const traintimeVolume = volume("traintime-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: POLLER_REGION, sizeMB: 5000 });
  const traintimeSite = service("traintime-site", {
    replicas: { "us-west2": 1 },
    env: { POLLER_URL: preserve(), RAILWAY_DOCKERFILE_PATH: preserve() },
    healthcheck: "/health",
    healthcheckTimeout: 30,
    build: { watchPatterns: WATCH },
  });
  const traintime = service("traintime", {
    replicas: { [POLLER_REGION]: 1 },
    deploy: { restartPolicyType: "ALWAYS" },
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
