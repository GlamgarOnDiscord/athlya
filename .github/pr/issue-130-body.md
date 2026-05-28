## Summary

- Étend `.github/workflows/deploy-production.yml` : phases `staging-deploy` + `production-deploy` (`wrangler deploy` + `wait-health-ready.sh`).
- Runbook `docs/runbooks/deploy-production.md` + checklist verify.
- Workflow renommé **Deploy API** (canary #129 + direct #130).

Closes #130

## Test plan

- [x] `node scripts/verify-deploy-production-checklist.mjs`
- [x] YAML workflow validé (phases + environment mapping)
- [ ] Run réel CF après merge (staging-deploy)
