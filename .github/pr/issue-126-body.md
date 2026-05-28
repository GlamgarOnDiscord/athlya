## Summary

- Runbook `docs/runbooks/qstash-quota.md` (alerte 80%, escalation, test staging, projection 5 studios).
- Script `scripts/verify-qstash-quota-checklist.mjs` (7 items ops).
- Monitor Axiom A14 + section cost-monitoring + launch checklist.
- Log structure `qstash.schedule.skipped` dans cascade-deps (pas de silence mode degrade).

Closes #126

## Test plan

- [x] `node scripts/verify-qstash-quota-checklist.mjs`
- [x] Docs only + log message cascade-deps
