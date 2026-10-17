# Runbook — Sentry source maps & release tracking (issues #138, #415)

## Goal

Make production stack traces **readable** (`file:line` instead of a minified bundle) and tie every Sentry event to a **release** = short git sha, on **every** path that ships a production Worker version.

## How it works

1. **Release tag on events** — the Worker sets `event.release = VERSION` (`packages/api/src/sentry.ts`). `VERSION` is injected at deploy time with `--var VERSION:${GITHUB_SHA:0:7}` (wrangler splits `--var` on `:`) on the gateway **and** on every sub-worker.
2. **Source maps** — every `wrangler.*.toml` sets `upload_source_maps = true`, and every deploy path bundles with `--outdir`: the gateway into `packages/api/dist`, each sub-worker into `packages/api/dist/<worker>`, which writes `*.js` + `*.js.map`.
3. **Sentry upload** — `scripts/sentry-release.sh` is the single implementation, shared by every path:
   - `prepare <env>`: `releases new <sha7>`, `sourcemaps inject dist`, `sourcemaps upload --release <sha7> dist`, `releases set-commits --auto`. It fails if `packages/api/dist` holds no `*.js.map`.
   - `finalize <env>`: `releases finalize <sha7>` + deploy marker `releases deploys <sha7> new -e <env>`.
   - `all <env>`: both, for direct deploys.

**Release name = `VERSION` = short sha**: this is what lets Sentry match an uploaded map to an incoming event (release + filename matching).

### Paths that ship a production Worker version

| Path                                          | Bundles                                                                              | Sentry steps                                                                                                         |
| --------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `deploy-production.yml` → `production-deploy` | `wrangler deploy --outdir dist[/<worker>]` (gateway + 3 sub-workers)                 | `sentry-release.sh all production` after the smoke                                                                   |
| `deploy-production.yml` → `production-canary` | `canary-deploy.mjs upload --outdir dist` (gateway)                                   | `prepare production` after the upload, **before** the first traffic shift; `finalize production` after 100 %         |
| `canary.yml` (push to `master`)               | sub-workers `wrangler deploy --outdir dist/<worker>`, gateway `upload --outdir dist` | `prepare production` after the gateway upload, **before** the first traffic shift; `finalize production` after 100 % |
| `deploy-production.yml` → `staging-deploy`    | same as `production-deploy`                                                          | `sentry-release.sh all staging` (soft-gated)                                                                         |

On the canary paths the gateway version is uploaded first (`wrangler versions upload` shifts no traffic), its maps reach Sentry, and `canary-deploy.mjs production-canary --version-id <id>` then promotes **that exact version**. The errors the canary error budget counts (`scripts/canary-error-budget.mjs`, same `<sha7>` release) are therefore already de-minified. In `canary.yml` the sub-workers take traffic right after their `wrangler deploy`; their maps are uploaded about a minute later, with the gateway's, so the first few sub-worker events of a rollout may stay minified.

The finalize step only runs when the canary succeeded: an aborted canary leaves an unfinalized release without a deploy marker, which is the intended signal.

## Required CI secrets / vars

| Key                 | Type   | Value                                                                      |
| ------------------- | ------ | -------------------------------------------------------------------------- |
| `SENTRY_AUTH_TOKEN` | secret | token with `project:releases` + `org:read` (Sentry settings → Auth Tokens) |
| `SENTRY_ORG`        | var    | Sentry organisation slug                                                   |
| `SENTRY_PROJECT`    | var    | project slug (e.g. `athlya-api`)                                           |

Soft gate **staging only**: when `SENTRY_AUTH_TOKEN`/`SENTRY_ORG`/`SENTRY_PROJECT` are missing, `sentry-release.sh` warns and skips without breaking `staging-deploy`. In **production** their absence **fails** the run on every path: `production-deploy`, `production-canary` (also guarded earlier by `Require Sentry config for production canary`, which checks `SENTRY_DSN` too) and `canary.yml` (`Check canary provisioning`) (#415).

## Verification (acceptance criteria)

1. **Readable stack trace**: after a `staging-deploy`, trigger a test error on staging (5xx route), open the event in Sentry → frames `worker.ts:LINE` (not minified).
2. **Associated release**: the event carries `release: <sha7>` and shows up in Sentry → Releases with a `staging` deploy marker.
3. **Canary**: after a `canary.yml` run, Sentry → Releases shows `<sha7>` finalized with a `production` deploy marker, and its artifacts list `worker.js.map` plus `auth/auth.js.map`, `reservations/…`, `billing/…`.

## Notes / limits

- **Frames in the event**: `packages/api/src/sentry.ts` parses `Error.stack` into `stacktrace.frames` (`filename`/`lineno`/`colno`). Without frames Sentry has nothing to match against the maps — this is the prerequisite for de-minification (fixed in #138).
- **Matching**: we rely on **release + filename** matching (event.release == uploaded release name). `sourcemaps inject` adds debug ids to the uploaded artifacts, but the bundle wrangler deployed does not carry them (the injection runs locally after the upload), so debug-id matching alone is not enough — hence `VERSION` must equal the release name.
- **`staging-smoke`** uploads a staging version only and has no Sentry step; it never ships production code.
- **Phase 3 (`@sentry/cloudflare` SDK)**: out of scope, rejected for bundle size (see the `sentry.ts` docblock + ADR #76).

## References

- `scripts/sentry-release.sh` — release + source maps (all paths)
- `.github/workflows/deploy-production.yml` — `Sentry release + source maps` steps
- `.github/workflows/canary.yml` — `Sentry release + source maps`, `Finalize Sentry release + deploy marker`
- `scripts/canary-deploy.mjs` — `upload --outdir`, `production-canary --version-id`
- `packages/api/wrangler*.toml` — `upload_source_maps = true`
- `packages/api/src/sentry.ts` — `event.release`
- `scripts/verify-sentry-sourcemaps-checklist.mjs`
