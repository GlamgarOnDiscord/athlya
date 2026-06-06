# Athlya — CI & Automation

This directory holds the GitHub automation for the Athlya monorepo. The default
`ci.yml` workflow runs on every pull request and on pushes to `main` or any
`release/*` branch. It installs dependencies with `pnpm --frozen-lockfile`, then
runs Prettier, ESLint, `tsc --noEmit`, and the Vitest suites (unit + fast-check
property tests) through Turborepo. **Unit / PGlite** paths run in `ci.yml`.
**Docker-backed PBT** (P4 cascade, P7 tenant Docker path, reservations
properties) run in `integration-docker.yml` on `ubuntu-latest` where the Docker
daemon is available. SQL RLS assertions use `pgtap.yml` when migrations change.

## Workflow matrix

| Workflow                 | Task | Trigger                                               | Status      |
| ------------------------ | ---- | ----------------------------------------------------- | ----------- |
| `ci.yml`                 | 13.1 | PRs, push to `master` / `release/*`                   | implemented |
| `integration-docker.yml` | 13.1 | PRs/push touching db/members/reservations/api         | implemented |
| `ci-required-vars.yml`   | 13.1 | Weekly + push `master` — K6/ZAP vars must be set      | implemented |
| `zap-baseline.yml`       | 13.2 | PRs when `vars.ZAP_TARGET_URL` is set                 | implemented |
| `load-test.yml`          | 13.2 | PRs when `vars.K6_STAGING_BASE_URL` is set            | implemented |
| `deps-audit.yml`         | 13.3 | daily cron + PRs touching lockfiles + manual dispatch | implemented |
| `pgtap.yml`              | 13.4 | PRs touching `packages/db` migrations or RLS tests    | implemented |

### Staging gate variables (required on `master`)

Configure under **Settings → Secrets and variables → Actions → Variables**:

| Variable              | Required for                            |
| --------------------- | --------------------------------------- |
| `K6_STAGING_BASE_URL` | k6 load tests (`load-test.yml`)         |
| `ZAP_TARGET_URL`      | OWASP ZAP baseline (`zap-baseline.yml`) |

`ci-required-vars.yml` fails on `master` when either is empty. Branch protection
checklist: `docs/runbooks/branch-protection.md`.

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

1. **`pnpm-audit`** — always runs, including on fork PRs without any secrets
   configured. Uses `pnpm audit --prod --audit-level=high` so that advisories
   affecting only devDependencies (Turborepo, Vitest, ESLint) don't block
   production releases. A machine-readable `audit-report.json` is uploaded as a
   workflow artifact (30-day retention) whether the job passes or fails, to
   make triage easy.

2. **`socket-security`** — runs the
   [SocketDev/socket-security-action](https://github.com/SocketDev/socket-security-action)
   for enhanced supply-chain analysis when the `SOCKET_SECURITY_API_KEY`
   repository secret is configured. On forks and repositories without the
   secret, the action step is skipped and a short notice is printed to the job
   log. The action version is pinned to an immutable tag so a compromised
   upstream cannot silently ship a malicious version; bump the pin via a
   reviewed PR when a newer stable tag is published.

### Configuring the Socket.dev integration

1. Create an API key in the Socket.dev dashboard.
2. Add it as a repository secret named `SOCKET_SECURITY_API_KEY` under
   **Settings → Secrets and variables → Actions → New repository secret**.
3. The next scheduled run (or the next relevant PR) will pick it up
   automatically. No workflow edits required.

### Temporarily tolerating an unpatched advisory

The scan is deliberately strict — `--audit-level=high` fails on any `high` or
`critical` production advisory. When an advisory surfaces that has no fix
available and affects a dependency you cannot swap out quickly:

- First, try `pnpm update <package>` and verify the advisory is no longer
  reported.
- If no patched version exists, open a tracking issue and, as a **temporary**
  mitigation, raise the threshold to `critical` in the `pnpm-audit` job step
  (`pnpm audit --prod --audit-level=critical`). Commit the change with a
  deadline in the message, link the tracking issue, and revert as soon as the
  upstream patch lands.
- Never silence the audit entirely. Never add `|| true` after the failing
  command.

## Notes for contributors

- No secrets are required to run CI. `TURBO_TOKEN` / `TURBO_TEAM` are optional
  and only enable Turborepo remote caching — forks without those secrets get
  the local cache for free and PRs still pass.
- `SOCKET_SECURITY_API_KEY` is likewise optional. The vendor-agnostic
  `pnpm-audit` job is the enforcement gate; Socket.dev is an additive
  supply-chain lens.
- Use `pnpm install --frozen-lockfile` locally to mirror CI behaviour.
- Keep the lockfile in sync: CI fails fast if `pnpm-lock.yaml` drifts.
