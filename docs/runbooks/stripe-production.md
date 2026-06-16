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

| Item                       | Staging | Production | Notes                                                     |
| -------------------------- | ------- | ---------- | --------------------------------------------------------- |
| STRIPE_SECRET_KEY          | [x]     | [x]        | mode test (`sk_test_...`), provisionné 2026-06-16         |
| STRIPE_WEBHOOK_SECRET      | [x]     | [x]        | 2 endpoints distincts dans Stripe Dashboard               |
| Webhook endpoint actif     | [x]     | [x]        | `*.workers.dev` (pas de domaine custom — voir ci-dessous) |
| Migration 0010             | [x]     | [x]        | `stripe_webhook_events` créée + grantée à `athlya_app`    |
| Checkout E2E admin         | [ ]     | [ ]        | **bloqué**, voir "Limite connue" ci-dessous               |
| Replay event.id idempotent | [ ]     | [ ]        | **bloqué**, idem                                          |

### ⚠️ Limite connue — pas de validation HTTP E2E sans domaine custom

Le gateway (`worker.ts`) applique une allowlist stricte sur le header `Host`
(issue #244, findings S3-003/S4-006) : seuls `api.athlya.app` et
`staging.api.athlya.app` sont acceptés en production/staging. Toute requête
vers l'URL `*.workers.dev` (la seule disponible — ce projet open-source n'a
pas de nom de domaine) reçoit un **404 délibéré**, avant même d'atteindre les
routes billing.

Conséquence : `smoke-stripe-webhook-config.mjs`, un vrai test `checkout.session.completed`
end-to-end, et le test de replay idempotent ne peuvent **pas** être exécutés
tant qu'aucun domaine réel n'est provisionné. Ce n'est pas un bug — c'est la
même protection qui empêche le host-header spoofing — mais ça bloque cette
validation spécifique.

**À refaire dès qu'un domaine existe** :

1. Provisionner le DNS pour `api.athlya.app` / `staging.api.athlya.app` (ou
   équivalent si le domaine final diffère).
2. `wrangler deploy --env staging` puis `--env production` (le code est déjà
   prêt, `workers_dev = true` ajouté en attendant comme fallback de test).
3. Lancer `node scripts/smoke-stripe-webhook-config.mjs` contre le vrai domaine.
4. `stripe trigger checkout.session.completed` en mode test pour valider le
   webhook réel + l'idempotency (rejouer le même event.id, vérifier qu'il
   n'est traité qu'une fois via `stripe_webhook_events`).

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
