# Runbook — Branch protection (issue #67)

CI billing / quota recovery : **[ci-recovery.md](./ci-recovery.md)** (issue #123).

`master` is protected by a classic branch protection rule (**Settings →
Branches → Branch protection rules → `master`**). The repository has no
rulesets (`gh api repos/GlamgarOnDiscord/athlya/rulesets` returns `[]`).

The REST API is the source of truth. Re-read it before trusting this page:

```bash
gh api repos/GlamgarOnDiscord/athlya/branches/master/protection
```

## Currently enforced

State read from the API on 2026-10-18 (issue #631):

| Setting                            | Value                                                         |
| ---------------------------------- | ------------------------------------------------------------- |
| Required status checks             | `Lint, typecheck, and tests` only (GitHub Actions, app 15368) |
| Strict (branch must be up to date) | `true`                                                        |
| Required approving reviews         | 1, from a code owner (`.github/CODEOWNERS`)                   |
| Dismiss stale reviews              | `true`; `require_last_push_approval: false`                   |
| Conversation resolution            | required: every review thread must be resolved before merge   |
| Linear history                     | required: squash or rebase merges only, no merge commits      |
| Force pushes / deletion            | both blocked (`allow_force_pushes`, `allow_deletions`: false) |
| Signed commits                     | not required                                                  |
| `enforce_admins`                   | `false`: repository admins can bypass every rule listed above |
| Lock branch / block creations      | off                                                           |

### Admin bypass

`enforce_admins: false` is what lets `gh pr merge <n> --squash --delete-branch --admin`
merge a PR that does not meet the rules. The bypass skips **all** of them at
once: the required check, the review and conversation resolution.

The only code owner is `@GlamgarOnDiscord`, and GitHub does not let an author
approve their own pull request. A PR opened from that account therefore can
never collect the required approval, and merging it needs the admin bypass.
Before using it, check by hand what the bypass no longer enforces:
`Lint, typecheck, and tests` green on the PR head SHA, every thread resolved,
bot reviews applied. Never use it to merge over a red required check that is
not a proven flake (see [CONTRIBUTING.md](../../CONTRIBUTING.md#break-glass-bypass-admin)).

Dependabot PRs are not authored by the code owner, so they can be approved
normally. GitHub auto-merge (`dependabot-auto-merge.yml`) waits for that
approval as well as for the required check and resolved conversations.

## Which checks run on a pull request

Only the first row blocks the merge. Every other check is informational for
branch protection, even when it is red. Triggers below are the `on:` blocks
of the workflows.

| Check (job name)                                                                    | Workflow                 | Runs on a PR when                                                                                                                              | Forks / Dependabot                                                                   |
| ----------------------------------------------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `Lint, typecheck, and tests` (**required**)                                         | `ci.yml`                 | every PR (`branches: '**'`)                                                                                                                    | runs; the Turbo remote cache is skipped without secrets                              |
| `Label hygiene`, `Documentation drift`                                              | `ci.yml`                 | every PR                                                                                                                                       | runs                                                                                 |
| `Property tests (Docker)`                                                           | `integration-docker.yml` | `packages/{db,members,reservations,api}/**` or the workflow changes                                                                            | runs                                                                                 |
| `pgTAP RLS suite`                                                                   | `pgtap.yml`              | `packages/db/migrations/**`, `packages/db/tests/rls/**`, `scripts/verify-role-contract.mjs` or the workflow changes                            | runs                                                                                 |
| axe / Lighthouse / Playwright E2E (web and studio)                                  | `axe.yml`                | `apps/web/**`, `apps/studio/**`, `packages/shared/**` or the workflow changes                                                                  | runs                                                                                 |
| `Production build (Next.js + Workers)`                                              | `build-check.yml`        | `apps/**`, most `packages/*/**` or the workflow changes                                                                                        | runs                                                                                 |
| `OpenNext build + dry-run + workerd smoke (web, studio)`                            | `frontend-worker.yml`    | `apps/{web,studio}/**`, `packages/shared/**`, `patches/**`, lockfile, `pnpm-workspace.yaml`, the frontend smoke script or the workflow changes | runs                                                                                 |
| `Run EXPLAIN ANALYZE on critical queries`                                           | `explain-analyze.yml`    | `packages/db/migrations/**`, `packages/db/src/schema/**`, Drizzle adapters, `packages/db/tests/explain/**` or the workflow changes             | runs                                                                                 |
| `OSV vulnerability scan (lockfile)`, `pnpm overrides documentation check`           | `deps-audit.yml`         | any `package.json`, `pnpm-lock.yaml` or the workflow changes                                                                                   | runs                                                                                 |
| `Analyze (...)`                                                                     | `codeql.yml`             | PR to `master` touching `.ts`, `.tsx`, `.js`, `.mjs`, `.cjs` or the workflow                                                                   | runs                                                                                 |
| `Run gitleaks`                                                                      | `secret-scan.yml`        | every PR to `master`                                                                                                                           | runs                                                                                 |
| `Terraform validate (credential-free)`, `Terraform plan (staging)`                  | `terraform.yml`          | PR to `master` touching `infra/terraform/**` or the workflow                                                                                   | see [terraform-ops.md](./terraform-ops.md)                                           |
| `Deploy preview (PR #n)`                                                            | `preview.yml`            | every PR, only when `vars.NEON_PROJECT_ID` is set                                                                                              | see [preview-pr.md](./preview-pr.md)                                                 |
| `Staging gate` (fails closed until staging exists)                                  | `staging-gate.yml`       | every PR to `master` (no `paths:` filter), every push to `master`, manual runs                                                                 | neutral skip: fork PRs and Dependabot runs cannot read the staging secrets           |
| `ZAP baseline scan (passive only)` (fails closed until staging exists)              | `zap-baseline.yml`       | every PR (`branches: '**'`), manual runs                                                                                                       | skipped on fork PRs; **fails** on Dependabot PRs when `vars.ZAP_TARGET_URL` is empty |
| `book-class load test`, `list-classes load test` (fail closed until staging exists) | `load-test.yml`          | `packages/reservations/**`, `packages/api/**`, `k6/**` or the workflow changes                                                                 | no special case: both fail whenever `vars.K6_STAGING_BASE_URL` is empty              |
| `k6 syntax lint`                                                                    | `load-test.yml`          | same paths as above                                                                                                                            | runs (no staging needed)                                                             |

Socket Security reports through its GitHub App (`Socket Security: Pull Request
Alerts`, `Socket Security: Project Report`), not through a workflow. Bot
reviews (CodeRabbit, cubic, Copilot) are not status checks either; their
threads are enforced through conversation resolution.

### Checks that fail closed until staging is provisioned

`Staging gate`, `ZAP baseline scan (passive only)` and the two k6 load-test
jobs fail on trusted runs while their staging prerequisites are missing. That
is deliberate (issues #340, #343): a scan or gate that never ran must not show
green. They are red on most PRs today and do not block the merge. Read their
logs anyway: a failure that is **not** the missing-prerequisite message is a
real regression.

`Staging gate (full soak)` is never a PR check: PR runs use a 2-minute k6
soak and skip it. It runs on push to `master` (10-minute soak), and
`deploy-production.yml` requires it, together with `Staging gate`, on the SHA
it promotes. See [deploy-production.md](./deploy-production.md#durée-du-soak-k6).

## Target, to enable once staging infra exists

These checks are worth requiring later. None of them is required today.

| Check                                               | Precondition before requiring it                                                                                                                                          |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Staging gate`                                      | Staging provisioned and green on `master` (secrets and vars in [deploy-production.md](./deploy-production.md)). It has no `paths:` filter, so it reports on every PR.     |
| `ZAP baseline scan (passive only)`                  | `vars.ZAP_TARGET_URL` set ([zap-activation.md](../operations/zap-activation.md)), and a decision on Dependabot PRs, which fail today instead of skipping.                 |
| `Property tests (Docker)`                           | Remove the `paths:` filter of `integration-docker.yml`, or add an always-reporting summary job. A required check that never reports leaves unrelated PRs blocked forever. |
| `pgTAP RLS suite`                                   | Same as above for `pgtap.yml`.                                                                                                                                            |
| `book-class load test` and `list-classes load test` | Same path-filter problem, plus `vars.K6_STAGING_BASE_URL` and the k6 secrets below.                                                                                       |

Add a check once its precondition holds. The context is the job name, exactly
as shown in the PR checks list:

```bash
gh api -X POST repos/GlamgarOnDiscord/athlya/branches/master/protection/required_status_checks/contexts \
  -f 'contexts[]=Staging gate'
```

Use the same call with `contexts[]=ZAP baseline scan (passive only)`,
`contexts[]=Property tests (Docker)`, `contexts[]=pgTAP RLS suite`,
`contexts[]=book-class load test` or `contexts[]=list-classes load test`.
Remove one with `-X DELETE` on the same endpoint. Then re-read the protection
and update the **Currently enforced** section of this page in the same PR.

## Repository variables (Actions)

`ci-required-vars.yml` runs every Monday at 07:00 UTC and on manual dispatch
(**Actions → CI required vars (staging gates) → Run workflow**). It fails while
any of these variables is empty:

| Variable                       | Used by                                                   |
| ------------------------------ | --------------------------------------------------------- |
| `STAGING_API_URL`              | `staging-gate.yml`, `deploy-production.yml`, `canary.yml` |
| `PRODUCTION_API_URL`           | `deploy-production.yml`, `canary.yml`, `rollback.yml`     |
| `K6_STAGING_BASE_URL`          | `staging-gate.yml`, `load-test.yml`                       |
| `ZAP_TARGET_URL`               | `zap-baseline.yml`                                        |
| `ZAP_ACTIVE_TARGET_URL`        | `zap-active.yml`                                          |
| `SYNTHETIC_TARGET_URL`         | `synthetics.yml`                                          |
| `SENTRY_ORG`, `SENTRY_PROJECT` | `canary.yml`, `deploy-production.yml`                     |
| `NEON_PROJECT_ID`              | `preview.yml`                                             |
| `CLOUDFLARE_WORKERS_SUBDOMAIN` | `preview.yml`                                             |
| `TF_CLOUD_ORGANIZATION`        | `terraform.yml`                                           |
| `STAGING_SMOKE_STUDIO_SLUG`    | `staging-gate.yml` (E2E booking journey)                  |

Its second job checks the `staging` environment values of the frontend
release smoke (#422).

## Secrets (staging load test)

- `book-class load test`: `K6_STAGING_AUTH_TOKENS` (CSV of JWTs, canonical;
  the singular `K6_STAGING_AUTH_TOKEN` is a legacy fallback),
  `K6_STAGING_STUDIO_ID`, `K6_STAGING_CLASS_IDS`.
- `list-classes load test`: `K6_STAGING_AUTH_TOKEN`.

See the `load-test.yml` header.
