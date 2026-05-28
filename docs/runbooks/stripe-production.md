# Stripe production — provisioning (issue #122)

**Owner:** Backend / billing ops  
**Prerequis:** API deployee staging + production, migration `0010_stripe_webhook_events.sql` appliquee.

---

## Objectif

Activer checkout + webhooks Stripe en staging puis production. Sans secrets `STRIPE_*`, checkout renvoie **503** et webhook **500** hors `dev` (fail-closed, issue #69).

---

## Phase 1 — Stripe Dashboard

1. Compte Stripe (mode **test** pour staging, **live** pour prod ou test pilote documente).
2. **Developers → Webhooks → Add endpoint**
   - Staging : `https://staging.api.athlya.app/v1/billing/webhook`
   - Production : `https://api.athlya.app/v1/billing/webhook`
3. Events minimum :
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.payment_failed`
4. Copier **Signing secret** (`whsec_...`) par environnement.
5. **API keys** : secret key `sk_test_...` / `sk_live_...` selon env.

Connect onboarding studio : voir [billing.md](./billing.md) § Connect.

---

## Phase 2 — Secrets Cloudflare Workers

```powershell
cd packages/api

pnpm exec wrangler secret put STRIPE_SECRET_KEY --env staging
pnpm exec wrangler secret put STRIPE_WEBHOOK_SECRET --env staging

pnpm exec wrangler secret put STRIPE_SECRET_KEY --env production
pnpm exec wrangler secret put STRIPE_WEBHOOK_SECRET --env production

pnpm exec wrangler deploy --env staging
pnpm exec wrangler deploy --env production
```

Ne jamais committer les cles. Stocker dans le vault ops.

---

## Phase 3 — Migration idempotency (Neon)

```powershell
$env:MIGRATION_DATABASE_URL = "postgresql://neondb_owner:...@..."
pnpm --filter @athlya/db run migrate
```

Verifier :

```sql
SELECT * FROM _athlya_migrations WHERE name = '0010_stripe_webhook_events.sql';
\d stripe_webhook_events
```

---

## Phase 4 — Validation

### Config webhook (sans signature valide)

```powershell
$env:ATHLYA_API_URL = "https://staging.api.athlya.app"
node scripts/smoke-stripe-webhook-config.mjs
# exit 0 = fail-closed (500/400), pas 200 silencieux avec secret absent
```

Avec secrets configures, meme script avec payload invalide doit retourner **400** (signature invalid), pas 500 config.

### stripe-cli (local / staging)

```bash
stripe listen --forward-to https://staging.api.athlya.app/v1/billing/webhook
stripe trigger checkout.session.completed
```

### Checklist ops

```powershell
node scripts/verify-stripe-provision-checklist.mjs
```

| Item | Staging | Production |
|------|---------|------------|
| STRIPE_SECRET_KEY | [ ] | [ ] |
| STRIPE_WEBHOOK_SECRET | [ ] | [ ] |
| Webhook endpoint actif | [ ] | [ ] |
| Migration 0010 | [ ] | [ ] |
| Checkout E2E admin | [ ] | [ ] |
| Replay event.id idempotent | [ ] | [ ] |

---

## Rollback

1. Desactiver webhook dans Stripe Dashboard (pause deliveries).
2. Retirer secrets (optionnel) ou laisser fail-closed 500.
3. `wrangler deploy` si changement de code.

---

## References

- `packages/api/src/routes/billing.ts`
- `packages/billing/src/webhook.ts`
- `docs/runbooks/billing.md`
- Issues #69, #122
