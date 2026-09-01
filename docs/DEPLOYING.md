# Deploying

Nothing deploys itself. Both targets are manual, deliberately.

## What still happens automatically

**Continuous integration, on every push to `main`** (`.github/workflows/ci.yml`): typecheck, tests,
lint, the network build, the data audit against the live poller, the design audit, the
accessibility audit and the static export. A regression is still caught the moment it lands —
only publishing waits to be asked for.

## The site

<https://traintime-site-production.up.railway.app>

```
npm run build:site                      # check it builds, and look at ./out
railway up --service traintime-site
```

A second Railway service beside the poller, serving the static export with compression. GitHub
Pages is gone: the repository is private and Pages needs a paid plan for that.

The two are separate services on purpose. The poller records the feeds continuously and its
recordings are the product, so restarting it to ship a stylesheet would cost a gap in the history
and a warm-up every time.

`railway.json` deliberately names neither a Dockerfile nor a start command — both services build
from this repository, so nothing in a shared config may assume which one it is. Each service picks
its Dockerfile through `RAILWAY_DOCKERFILE_PATH` and its process through that Dockerfile's `CMD`.
The site is told where the poller lives at build time through `POLLER_URL`.

## The poller

The Railway service is no longer connected to the repository, so a push does not redeploy it.
To ship a change:

```
railway up --service traintime
```

To put the automatic deploys back:

```
railway service source connect --repo oddurs/traintime --branch main --service traintime
```

Disconnecting the source does not stop the running deployment — the service kept serving through
it, and `/health` is the way to confirm that after any change:

```
curl -s https://traintime-production-6a7d.up.railway.app/health | jq '{ok, trains, feeds: .feeds.healthy}'
```

## Before shipping either

```
npm test && npm run lint && npm run typecheck
npm run audit          # live data invariants
npm run audit:design   # every value comes from the token layer
npm run audit:a11y     # names, heading order, the live region
npm run audit:weight   # what it costs on a slow connection
node scripts/audit-ui.mjs && MOBILE=1 node scripts/audit-ui.mjs
```
