# Athlya — CI & Automation

This directory holds the GitHub automation for the Athlya monorepo. The default
`ci.yml` workflow runs on every pull request and on pushes to `master` or any
`release/*` branch. It installs dependencies with `pnpm --frozen-lockfile`, then
runs Prettier, ESLint, `tsc --noEmit`, and the Vitest suites (unit + fast-check
property tests) through Turborepo. **Unit / PGlite** paths run in `ci.yml`.
**Docker-backed PBT** (P4 cascade, P7 tenant Docker path, reservations
properties) run in `integration-docker.yml` on `ubuntu-latest` where the Docker
daemon is available. SQL RLS assertions use `pgtap.yml` when migrations or RLS
tests change.

Only the `Lint, typecheck, and tests` job of `ci.yml` is a required status
check on `master`. Protection settings, every PR check with its trigger, and
the checks to require later: `docs/runbooks/branch-protection.md`.

## Workflow matrix

| Workflow                 | Task | Trigger                                                                                    | Status      |
| ------------------------ | ---- | ------------------------------------------------------------------------------------------ | ----------- |
| `ci.yml`                 | 13.1 | PRs, push to `master` / `release/*`                                                        | implemented |
| `integration-docker.yml` | 13.1 | PRs/push to `master` touching db/members/reservations/api                                  | implemented |
| `ci-required-vars.yml`   | 13.1 | Weekly (Monday 07:00 UTC) + manual — required repository vars must be set                  | implemented |
| `zap-baseline.yml`       | 13.2 | Every PR + manual; fails while `vars.ZAP_TARGET_URL` is empty                              | implemented |
| `load-test.yml`          | 13.2 | PRs touching reservations/api/k6 + manual; fails while `vars.K6_STAGING_BASE_URL` is empty | implemented |
| `deps-audit.yml`         | 13.3 | daily cron + PRs touching `package.json`/lockfile + manual dispatch                        | implemented |
| `pgtap.yml`              | 13.4 | PRs/push to `master` touching migrations, RLS tests or the role contract                   | implemented |

### Staging variables

Configure under **Settings → Secrets and variables → Actions → Variables**.
`ci-required-vars.yml` lists every required variable and fails its weekly run
while one is empty. Among them:

| Variable              | Required for                                                   |
| --------------------- | -------------------------------------------------------------- |
| `K6_STAGING_BASE_URL` | k6 load tests (`load-test.yml`), k6 step of `staging-gate.yml` |
| `ZAP_TARGET_URL`      | OWASP ZAP baseline (`zap-baseline.yml`)                        |

Until staging is provisioned, `Staging gate`, the ZAP baseline and the k6 load
tests fail closed on pull requests. They are not required checks and do not
block the merge. Full variable list: `docs/runbooks/branch-protection.md`.

Dependabot keeps npm and GitHub Actions dependencies up to date on a weekly
cadence (`dependabot.yml`).

## Daily dependency scan (`deps-audit.yml`)

The daily scan satisfies Requirement 29.2 — "run a daily dependency scan against
the lockfile and fail the nightly build when a critical vulnerability is
reported". It runs:

- every day at **06:00 UTC** via `schedule`,
- on pull requests that touch `**/package.json`, `pnpm-lock.yaml`, or the
  workflow file itself,
- on demand via `workflow_dispatch`.

Two jobs run in parallel:

1. **`OSV vulnerability scan (lockfile)`** — runs
   `google/osv-scanner-action` against `pnpm-lock.yaml` (runtime and dev
   dependencies). It fails on any finding and on any scanner error, and
   uploads `osv-report.json` as a workflow artifact (30-day retention). No
   secrets required; safe for forks.

2. **`pnpm overrides documentation check`** — `scripts/check-overrides.mjs`
   warns (never fails) when a pnpm override is undocumented in
   `scripts/overrides-rationale.json` or older than six months. The job fails
   when the installed pnpm does not match `packageManager`.

Socket Security supply-chain scanning comes from the Socket GitHub App
(separate `Socket Security: …` checks), not from this workflow.

### Temporarily tolerating an unpatched advisory

When an advisory has no fix available and affects a dependency you cannot swap
out quickly:

- First, try `pnpm update <package>` and verify the advisory is no longer
  reported.
- If no patched version exists, open a tracking issue and add an
  `[[IgnoredVulns]]` entry to `osv-scanner.toml` with the advisory `id`, a
  `reason` and an `ignoreUntil` expiry. Drop it as soon as the upstream patch
  lands.
- Never silence the scan entirely. Never add `|| true` after the failing
  command.

## Notes for contributors

- No secrets are required to run CI. `TURBO_TOKEN` / `TURBO_TEAM` are optional
  and only enable Turborepo remote caching — forks without those secrets get
  the local cache for free and PRs still pass.
- Use `pnpm install --frozen-lockfile` locally to mirror CI behaviour.
- Keep the lockfile in sync: CI fails fast if `pnpm-lock.yaml` drifts.
