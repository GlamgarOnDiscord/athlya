## Summary

- Policy `fail-closed-soft` dans `limiter-guard.ts` : 429 synthétique (`rate_limit_dependency_unavailable`) quand Upstash throw avant `next()`.
- Limiter global `/v1/*` : `fail-open` → `fail-closed-soft` (issue #128). Auth/mutations restent fail-closed 503.
- `/health` et `/health/ready` inchangés (hors `/v1/*`).
- Log `outcome: dependency_denied` sur panne Redis global.
- Doc `audit-S4-network.md` alignée.

Closes #128

## Test plan

- [x] `pnpm exec tsc --noEmit -p packages/api`
- [x] `pnpm --filter @athlya/api test -- src/__tests__/limiter-guard.test.ts`
- [x] `pnpm --filter @athlya/api test -- src/__tests__/global-limiter-redis-down.test.ts`
