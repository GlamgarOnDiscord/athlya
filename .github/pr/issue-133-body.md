## Summary

- Registry `rate-limit-policies.ts` + matrice `docs/security/rate-limit-coverage.md`.
- Fail-closed dédié sur reads coûteux : search, members list, audit, admin stats.
- Tests table-driven policies + Redis down.

Closes #133

## Test plan

- [x] `pnpm --filter @athlya/api test -- src/__tests__/rate-limit-policies.test.ts src/__tests__/expensive-read-limiter-redis-down.test.ts`
- [x] `node scripts/verify-rate-limit-coverage-checklist.mjs`
