# Athlya — CI & Automation

This directory holds the GitHub automation for the Athlya monorepo. The default
`ci.yml` workflow runs on every pull request and on pushes to `main` or any
`release/*` branch. It installs dependencies with `pnpm --frozen-lockfile`, then
runs Prettier, ESLint, `tsc --noEmit`, and the Vitest suites (unit + fast-check
property tests) through Turborepo. Testcontainers-based suites skip cleanly on
the default `ubuntu-latest` runner when Docker is unavailable; a dedicated
Postgres-backed job (`pgtap.yml`) runs the RLS suite against a real Postgres 17
service container whenever SQL migrations change.

## Workflow matrix

| Workflow           | Task | Trigger                                               | Status      |
| ------------------ | ---- | ----------------------------------------------------- | ----------- |
| `ci.yml`           | 13.1 | PRs, push to `main` / `release/*`                     | implemented |
| `zap-baseline.yml` | 13.2 | PRs (planned)                                         | planned     |
| `deps-audit.yml`   | 13.3 | daily cron + PRs touching lockfiles + manual dispatch | implemented |
| `pgtap.yml`        | 13.4 | PRs touching `packages/db` migrations or RLS tests    | implemented |

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
