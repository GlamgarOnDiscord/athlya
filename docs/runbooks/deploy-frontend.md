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

The workflow fails before building when a required value is missing.

## Deploy

Actions → **Deploy Frontend** → `environment` = staging | production,
`phase` = deploy, `apps` = all | web | studio. The job:

1. builds the selected Workers with that environment's `NEXT_PUBLIC_*` values;
2. `wrangler deploy --env <env> --var VERSION:<sha>`;
3. waits until `WEB_URL/robots.txt` and `STUDIO_URL/login` serve 200;
4. runs `scripts/smoke-frontend.mjs` against the **real** URLs: public pages 200,
   per-request CSP nonce + `frame-ancestors 'none'`, HSTS, auth route handlers
   answer 4xx (not 5xx) to an anonymous refresh, API `/health` 200.

In production, any failure after the deploy step rolls the selected apps back and
the job stays **red**. Staging is left as-is for investigation.

Locally (same commands as CI):

```bash
pnpm --filter @athlya/shared build
NEXT_PUBLIC_API_URL=https://staging.api.athlya.app pnpm --filter @athlya/web build:worker
pnpm --filter @athlya/web exec wrangler deploy --env staging
WEB_URL=https://staging.athlya.app node scripts/smoke-frontend.mjs
```

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
- Browser flows (`apps/*/e2e`) stay in `axe.yml`; they stub the network and are not
  a release signal on their own. The release signal against the real API is the
  staging gate (`staging-gate.yml`) plus this post-deploy smoke.

## Contract compatibility

When an API release changes a contract that web/studio depend on:

1. Deploy API first (`deploy-production.yml` → `staging-deploy`).
2. Smoke the API via `scripts/smoke-routes.mjs`.
3. Then deploy frontend via this workflow.

If the deploy fails and the API was already promoted, rollback the
frontend first, then rollback the API if needed.
