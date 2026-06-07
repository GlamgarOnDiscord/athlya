## Résumé

Stripe checkout retourne **503** sans secrets. Webhook sans `STRIPE_WEBHOOK_SECRET` → **500 fail-closed** (OK sécurité) mais **revenue = 0**. Mode dégradé documenté dans `billing.ts` toujours actif.

**Finding audit** : C3 / C4 — gravité **High**, priorité **P0 business**.

Issue #69 fermée (webhook fail-closed code) — **secrets prod + Connect non provisionnés**.

## Comportement attendu

- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, Connect account IDs en prod
- Checkout session créée → paiement réel
- Webhook `checkout.session.completed` → subscription active en DB
- Idempotency table migration 0010 appliquée Neon prod

## Comportement observé

```typescript
// packages/api/src/routes/billing.ts — mode dégradé
// Sans STRIPE_* : checkout 503, dashboard billing vide
```

Epic 16 : 🟡 1/3 tâches. Premier studio payant **ne peut pas payer**.

## Impact production

- Revenus = 0
- Marketing "SaaS abonnement studio" **faux**
- Webhook mal configuré après go-live = events perdus (Stripe retry limité)

## Solution proposée

### Phase 1 — Stripe Dashboard

1. Compte Stripe **live** (pas test) ou test mode pilote explicite
2. Connect : platform + onboarding studio
3. Webhook endpoint `https://api.athlya.app/v1/billing/webhook`
4. Events : `checkout.session.completed`, `customer.subscription.*`, `invoice.payment_failed`

### Phase 2 — Secrets wrangler production

```bash
wrangler secret put STRIPE_SECRET_KEY --env production
wrangler secret put STRIPE_WEBHOOK_SECRET --env production
# Connect client ID si applicable
```

### Phase 3 — Migration idempotency

Appliquer migration Stripe events table (issue #69) sur Neon prod.

### Phase 4 — Test E2E

1. Checkout test studio pilote
2. Vérifier row `subscriptions` + audit log
3. Simuler webhook replay → idempotent (pas double charge)

## Composants touchés

- [ ] Stripe Dashboard (live ou test pilote documenté)
- [ ] Secrets Cloudflare production
- [ ] `packages/api/src/routes/billing.ts`
- [ ] Migration Neon idempotency
- [ ] `docs/runbooks/stripe-production.md` (créer/mettre à jour)

## Critères d'acceptation

- [ ] Checkout E2E réussi staging + prod (ou prod test mode documenté)
- [ ] Webhook signature validée, events persistés
- [ ] Idempotency replay test pass
- [ ] Runbook rollback billing documenté

## Références

- `packages/api/src/routes/billing.ts`
- Issue fermée #69
- Audit prod 2026-05-27 — C3, C4, S5

## Priorité

**P0 business** — bloquant monétisation
