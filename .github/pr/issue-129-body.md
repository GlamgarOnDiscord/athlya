## Summary

- Script `scripts/canary-deploy.mjs` (upload, promote, staging-smoke, production-canary 5→25→100, rollback).
- Workflow `.github/workflows/deploy-production.yml` (`workflow_dispatch` : staging-smoke, production-canary, rollback).
- Runbook `canary-deploy.md` aligné CI + critères rollback.
- Checklist `scripts/verify-canary-deploy-checklist.mjs` + bloc launch checklist.
- `rules.md` — workflow agent/humain (référence repo, demandé avant enchaînement issues).

Closes #129

## Test plan

- [x] `node scripts/verify-canary-deploy-checklist.mjs`
- [x] `node scripts/canary-deploy.mjs` (usage / exit codes)
- [ ] Deploy réel CF : ops après merge (secrets + vars + environment approval)
