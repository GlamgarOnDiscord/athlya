# Runbook — Branch protection (issue #67)

Configure on **Settings → Branches → Branch protection rules → `master`**.

## Required status checks

| Check | Workflow | Purpose |
|-------|----------|---------|
| `ci` / Lint, typecheck, and tests | `ci.yml` | Unit + PGlite property paths |
| `integration-docker` / Property tests (Docker) | `integration-docker.yml` | P4 cascade, P7 tenant (Docker), reservations PBT |
| `pgtap` / pgTAP RLS suite | `pgtap.yml` | SQL RLS assertions (on migration paths) |

Optional but recommended when staging is live:

| Check | Workflow | Requires |
|-------|----------|----------|
| `load-test` jobs | `load-test.yml` | `vars.K6_STAGING_BASE_URL` + secrets |
| `zap` job | `zap-baseline.yml` | `vars.ZAP_TARGET_URL` |

Weekly `ci-required-vars.yml` fails on `master` if `K6_STAGING_BASE_URL` or `ZAP_TARGET_URL` are empty.

## Repository variables (Actions)

| Variable | Example | Used by |
|----------|---------|---------|
| `K6_STAGING_BASE_URL` | `https://staging.api.athlya.app` | `load-test.yml` |
| `ZAP_TARGET_URL` | `https://app.staging.athlya.app` | `zap-baseline.yml` |
| `NEON_PROJECT_ID` | Neon project id | `preview.yml` |
| `CLOUDFLARE_WORKERS_SUBDOMAIN` | `athlya` | `preview.yml` |

## Secrets (staging load test)

`K6_STAGING_AUTH_TOKEN`, `K6_STAGING_STUDIO_ID`, `K6_STAGING_CLASS_IDS` — see `load-test.yml` header.

## Note — P1 booking property

`packages/reservations/tests/properties/booking.property.test.ts` remains `describe.skip` (withTenant scope). `integration-docker` still runs other reservations property suites; un-skip P1 in a follow-up issue.
