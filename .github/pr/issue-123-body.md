## Summary

- `docs/runbooks/ci-recovery.md` — quota billing, self-hosted runners, branch protection validation.
- `scripts/verify-ci-health.mjs` — latest master runs for ci / pgtap / integration-docker.
- `scripts/verify-ci-provision-checklist.mjs` — ops checklist CLI.
- Links from `branch-protection.md` and launch checklist.

Restauration quota GitHub reste manuelle (Settings → Billing).

Closes #123

## Test plan

- [x] `node scripts/verify-ci-provision-checklist.mjs`
- [x] `node scripts/verify-ci-health.mjs` (gh CLI)
