# Deploying

Nothing deploys itself. Both targets are manual, deliberately.

## What still happens automatically

**Continuous integration, on every push to `main`** (`.github/workflows/ci.yml`): typecheck, tests,
lint, the network build, the data audit against the live poller, the design audit, the
accessibility audit and the static export. A regression is still caught the moment it lands —
only publishing waits to be asked for.

## The site

```
gh workflow run "Deploy to GitHub Pages"
```

The workflow builds and publishes `out/`. **It will not succeed while the repository is private**:
GitHub Pages needs a paid plan for private repositories, so the publish step fails even when run
by hand. The build half still runs and is still useful as a check.

If the site needs to be public again, the options are a GitHub plan that allows Pages on private
repositories, or hosting the static export somewhere that serves private repositories on a free
tier — Railway (where the poller already lives), Cloudflare Pages, Vercel or Netlify all do.

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
