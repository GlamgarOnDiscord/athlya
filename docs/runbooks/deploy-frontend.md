# Runbook — Frontend deploy (apps/web + apps/studio)

Issue #422. Both Next.js 16 apps ship as **Cloudflare Workers built by OpenNext**
(`@opennextjs/cloudflare`), on the same account as the API
(ADR: `docs/security/deploy-web-adr.md`).

## Architecture

| App           | Worker (staging / production)             | Config                       |
| ------------- | ----------------------------------------- | ---------------------------- |
| `apps/web`    | `athlya-web-staging` / `athlya-web`       | `apps/web/wrangler.jsonc`    |
| `apps/studio` | `athlya-studio-staging` / `athlya-studio` | `apps/studio/wrangler.jsonc` |

- `pnpm --filter @athlya/<app> build:worker` = `next build` + OpenNext bundle in
  `.open-next/` (`worker.js` + static `assets/`).
- `NEXT_PUBLIC_*` values are **inlined at build time**: build once per environment.
- Runtime var `APP_ENV` (staging / production) comes from `wrangler.jsonc`
  (`Secure` cookies, issue #465). Custom domains / routes are attached in the
  Cloudflare dashboard.
- Bundle size ≈ 2.6–3.1 MiB gzip → **Workers Paid** plan (10 MiB limit).
- `patches/@opennextjs__cloudflare@1.20.10.patch`: Next 16.4 loads
  `.next/server/preview-props.json` unconditionally; without the patch every route
  answers 500 in the Worker. Remove it once OpenNext ships the fix (bump the version
  and drop `patchedDependencies` in `pnpm-workspace.yaml`).

## Prerequisites (per GitHub environment `staging` / `production`)

| Kind   | Name                    | Notes                                       |
| ------ | ----------------------- | ------------------------------------------- |
| secret | `CLOUDFLARE_API_TOKEN`  | Workers Scripts:Edit                        |
| secret | `CLOUDFLARE_ACCOUNT_ID` |                                             |
| var    | `WEB_URL`               | e.g. `https://staging.athlya.app`           |
| var    | `STUDIO_URL`            | e.g. `https://staging.studio.athlya.app`    |
| var    | `API_URL`               | e.g. `https://staging.api.athlya.app`       |
| var    | `TURNSTILE_SITE_KEY`    | optional (`NEXT_PUBLIC_TURNSTILE_SITE_KEY`) |
| var    | `CSP_REPORT_URI`        | optional (`NEXT_PUBLIC_CSP_REPORT_URI`)     |

Browser release smoke, **staging environment only** (production runs the
anonymous pass, which needs no credential):

| Kind   | Name                           | Notes                                                          |
| ------ | ------------------------------ | -------------------------------------------------------------- |
| secret | `STAGING_SMOKE_EMAIL`          | member smoke account (shared with `staging-gate.yml`)          |
| secret | `STAGING_SMOKE_PASSWORD`       |                                                                |
| secret | `STAGING_SMOKE_ADMIN_EMAIL`    | **new** — `admin` of the smoke studio (separate account)       |
| secret | `STAGING_SMOKE_ADMIN_PASSWORD` | **new**                                                        |
| var    | `TURNSTILE_SITE_KEY`           | Cloudflare test site key `1x00000000000000000000AA` on staging |

The workflow fails before building when a required value is missing; on a
staging deploy that includes the smoke credentials of the selected apps.
`ci-required-vars.yml` (job _Verify staging release-smoke configuration_)
inventories the staging values weekly.

Staging data the flows rely on:

- the member smoke account belongs to a studio that has **at least one class
  with a free seat in the next 14 days, starting more than 3 h ahead** (the web
  list shows 14 days; the API refuses cancellations less than 2 h before start);
- the admin smoke account is `admin` of a studio (the smoke studio is fine);
- the staging API runs the Turnstile **test secret**
  (`1x0000000000000000000000000000000AA`) so the dummy token the test site key
  issues to the headless browser verifies.

## Deploy

Actions → **Deploy Frontend** → `environment` = staging | production,
`phase` = deploy, `apps` = all | web | studio. The job:

1. builds the selected Workers with that environment's `NEXT_PUBLIC_*` values;
2. `wrangler deploy --env <env> --var VERSION:<sha>`;
3. waits until `WEB_URL/robots.txt` and `STUDIO_URL/login` serve 200;
4. runs `scripts/smoke-frontend.mjs` against the **real** URLs: public pages 200,
   per-request CSP nonce + `frame-ancestors 'none'`, HSTS, auth route handlers
   answer 4xx (not 5xx) to an anonymous refresh, API `/health` 200;
5. runs the **browser release smoke** (Playwright + Chromium,
   `apps/{web,studio}/e2e/release/*.release.ts`, config `e2e/release.config.ts`)
   against the deployed Workers and the real API — no `page.route()` stubs.

| Flow                                                                                       | Staging (`full`) | Production (`public`) |
| ------------------------------------------------------------------------------------------ | ---------------- | --------------------- |
| Pages hydrate with no CSP refusal; anonymous `/classes` / `/dashboard/classes` → `/login`  | yes              | yes                   |
| Member: log in → list classes → book a free seat → cancel it                               | yes              | no                    |
| Studio admin: log in → classes table → create a class 100 days ahead → delete it           | yes              | no                    |
| Password reset: request for `<smoke-local>+reset-<run>@<domain>` → generic confirmation UI | yes              | no                    |

The scope comes from `RELEASE_SMOKE_SCOPE` (`full` on staging, `public` on
production). Production cannot run the `@turnstile` flows: its Turnstile secret
is real and each token is single-use (same decision as the API canary,
`canary-deploy.md`). Instead, a **production deploy requires a green staging
deploy job on the same commit** (`deploy all (staging)` or `deploy <app> (staging)`,
checked with `scripts/require-check-success.mjs`), so the full flows ran on the
exact code being shipped.

Clean-up and idempotency:

- the web app has no cancel button yet: the reservation booked through the UI is
  cancelled through `DELETE /v1/reservations/:id` with the session the login form
  produced. An `afterEach` hook cancels it again when a later step failed or timed
  out; a class the account already holds (409, e.g. a concurrent staging gate) is
  skipped and left to its owner;
- the studio class is created 100 days ahead (outside the 14-day member list and the
  staging gate's 90-day booking window) and deleted through the UI; `afterEach`
  deletes it through the API on failure, and each run first sweeps `Release smoke *`
  classes a killed run left behind;
- the reset request goes to a per-run sub-address of the smoke mailbox, not to the
  account address: the API allows 3 reset requests per address per 24 h, and the
  sub-address matches no account, so no token is created and no email is sent while
  the UI, Turnstile, the proxy and the API answer exactly as for a real account.

Traces and videos are off (they would record the typed credentials); a failing test
keeps a screenshot in the runner's `test-results/`, which is not uploaded.

In production, any failure after the deploy step rolls the selected apps back and
the job stays **red**. Staging is left as-is for investigation.

Locally (same commands as CI):

```bash
pnpm --filter @athlya/shared build
NEXT_PUBLIC_API_URL=https://staging.api.athlya.app pnpm --filter @athlya/web build:worker
pnpm --filter @athlya/web exec wrangler deploy --env staging
WEB_URL=https://staging.athlya.app node scripts/smoke-frontend.mjs
WEB_URL=https://staging.athlya.app API_URL=https://staging.api.athlya.app \
  SMOKE_EMAIL=… SMOKE_PASSWORD=… pnpm --filter @athlya/web e2e:release
STUDIO_URL=https://staging.studio.athlya.app API_URL=https://staging.api.athlya.app \
  SMOKE_ADMIN_EMAIL=… SMOKE_ADMIN_PASSWORD=… pnpm --filter @athlya/studio e2e:release
```

A missing variable makes the release config throw before any test runs.

## Rollback

Actions → **Deploy Frontend** → `phase` = rollback (same `environment` / `apps`).
`wrangler rollback` restores the previous version and the smoke re-runs; a failed
rollback fails the job (no `continue-on-error`). Manual:

```bash
pnpm --filter @athlya/web exec wrangler rollback --env production -y --message "<reason>"
```

## CI gates

- `ci.yml` — `pnpm build` (Next production build of both apps) and the unit tests;
  studio no longer passes with zero tests (`--passWithNoTests` removed).
- `frontend-worker.yml` (PRs touching `apps/**`, `packages/shared/**`, the lockfile
  or the patch) — per app: OpenNext build, `wrangler deploy --dry-run --env production`,
  then serves the bundle in workerd (`wrangler dev`) and runs `smoke-frontend.mjs`
  against it.
- Hermetic browser flows (`apps/*/e2e/*.spec.ts`, `apps/*/e2e/flows`) stay in
  `axe.yml`; they stub the network and are not a release signal on their own. The
  release signal against the real API is the staging gate (`staging-gate.yml`) plus
  this post-deploy smoke (`*.release.ts`, which the hermetic configs never match).
- `e2e/**` is typechecked (`e2e/tsconfig.json`, part of each app's `typecheck`)
  and linted with the app.

## Contract compatibility

When an API release changes a contract that web/studio depend on:

1. Deploy API first (`deploy-production.yml` → `staging-deploy`).
2. Smoke the API via `scripts/smoke-routes.mjs`.
3. Then deploy frontend via this workflow.

If the deploy fails and the API was already promoted, rollback the
frontend first, then rollback the API if needed.
