# Runbook — Frontend deploy (apps/web + apps/studio)

Issue #422. See also [`deploy-unified.md`](./deploy-unified.md) for the API +
frontend combined deploy order.

## Architecture

| App              | Worker name     | URL (production)            |
| ---------------- | --------------- | --------------------------- |
| `@athlya/web`    | `athlya-web`    | `https://app.athlya.app`    |
| `@athlya/studio` | `athlya-studio` | `https://studio.athlya.app` |

Both apps use **OpenNext → Cloudflare Workers** (see
`docs/security/deploy-web-adr.md`). Each app has a `wrangler.toml` that
defines `[env.staging]` and `[env.production]` with CF zone bindings.

## Deploy prerequisites

GitHub secrets and vars required in addition to the API deploy:

| Key                     | Where  | Purpose                                  |
| ----------------------- | ------ | ---------------------------------------- |
| `CLOUDFLARE_API_TOKEN`  | secret | Workers:Edit (same token as API)         |
| `CLOUDFLARE_ACCOUNT_ID` | secret | CF account ID                            |
| `SENTRY_AUTH_TOKEN`     | secret | Source map upload (optional)             |
| `STAGING_WEB_URL`       | var    | e.g. `https://staging.athlya.app`        |
| `STAGING_STUDIO_URL`    | var    | e.g. `https://staging.studio.athlya.app` |
| `PRODUCTION_WEB_URL`    | var    | e.g. `https://app.athlya.app`            |
| `PRODUCTION_STUDIO_URL` | var    | e.g. `https://studio.athlya.app`         |
| `SENTRY_ORG`            | var    | Sentry org slug (optional)               |
| `SENTRY_PROJECT`        | var    | Sentry project slug (optional)           |

## Deploy to staging

```bash
gh workflow run deploy-frontend.yml \
  -f phase=staging-deploy \
  -f apps=all
```

Steps:

1. Build `@athlya/shared`
2. Build `@athlya/web` + `@athlya/studio` (`next build`)
3. `wrangler deploy --env staging` for each app
4. Playwright axe + member flow smoke tests against `STAGING_WEB_URL`

## Deploy to production

Always deploy the API first when the PR changes the API contract (see
`deploy-unified.md` § Deploy order).

```bash
gh workflow run deploy-frontend.yml \
  -f phase=production-deploy \
  -f apps=all
```

Additional steps beyond staging:

- Sentry release creation + source map upload for both apps
- Ready gate (`scripts/wait-health-ready.sh`) after each wrangler deploy
- Auto-rollback on failure (wrangler rollback for each app)

## Deploy one app only

```bash
gh workflow run deploy-frontend.yml \
  -f phase=staging-deploy \
  -f apps=web
```

## Rollback

```bash
gh workflow run deploy-frontend.yml \
  -f phase=rollback \
  -f apps=all
```

Rolls back both Workers to the previous uploaded version. Safe to run for
either app independently (`apps=web` or `apps=studio`).

## E2E smoke coverage

The `e2e/flows` suite covers:

- Register → book class → cancel (member flow)
- Profile edit

The `e2e/axe.spec.ts` covers WCAG 2.2 AA accessibility (core pages).

Add CSP and security header checks to the Playwright config when the
CSP nonce implementation is stable (tracked in `apps/web/src/proxy.ts`).

## Contract compatibility

When an API release changes a contract that web/studio depend on:

1. Deploy API first (`deploy-production.yml` → `staging-deploy`).
2. Smoke the API via `scripts/smoke-routes.mjs`.
3. Then deploy frontend via this workflow.

If the deploy fails and the API was already promoted, rollback the
frontend first, then rollback the API if needed.
