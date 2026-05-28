## Summary

- Store Drizzle `createDrizzleAuditLogStore` + wiring `audit-log-wiring.ts` (JWT rotate, DLQ replay/discard, billing webhook).
- Actions audit : `jwt.key.rotation_prep`, `dlq.entry.replayed`, `dlq.entry.discarded`, `billing.webhook.processed`.
- Worker : lazy writers sur `/admin/*` (env Worker indisponible au buildApp).
- `billing-deps` : fin des no-ops audit/tx sur webhooks Stripe.
- Runbook `admin-access.md` aligné sur le slug `jwt.key.rotation_prep`.

Closes #127

## Test plan

- [x] `pnpm exec tsc --noEmit -p packages/api`
- [x] `pnpm --filter @athlya/api test -- src/__tests__/dlq-routes.test.ts`
- [x] `pnpm --filter @athlya/billing test -- src/__tests__/webhook.test.ts`
