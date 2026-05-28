## Summary

- `docs/runbooks/stripe-production.md` — provisioning secrets, webhooks, migration 0010, E2E checklist.
- `scripts/smoke-stripe-webhook-config.mjs` — verify webhook fail-closed or signature reject.
- `scripts/verify-stripe-provision-checklist.mjs` — ops checklist CLI.
- Fix stale mode degrade comment in `billing.ts` (webhook 500 hors dev).
- Launch checklist + link from `billing.md`.

Secrets Stripe et dashboard restent manuels.

Closes #122

## Test plan

- [x] `node scripts/verify-stripe-provision-checklist.mjs`
- [ ] `ATHLYA_API_URL=https://staging.api.athlya.app node scripts/smoke-stripe-webhook-config.mjs` post-deploy
