## Résumé

Billing Stripe est en **mode dégradé** (Epic 16 🟡 1/3). Sans secrets `STRIPE_*`, checkout retourne 503 mais webhook répond **200 no-op** pour stopper retries Stripe — events billing **perdus silencieusement**.

## Comportement observé

`packages/api/src/routes/billing.ts` :

- `POST /checkout` → 503 `billing_not_configured`
- `POST /webhook` sans secret → 200 warn log

`packages/billing/src/webhook.ts` — handler complet mais composition webhook raw-body documentée comme fragile.

## Impact

- **Sévérité** : High / P1 si monétisation
- Revenus = 0 en prod sans config
- Misconfig secret = events Stripe ack sans traitement

## Solution proposée

### 1. Webhook fail-closed production

```typescript
if (!env.STRIPE_WEBHOOK_SECRET && env.ENVIRONMENT === 'production') {
  return c.json({ code: 'configuration_error' }, 500);
}
```

### 2. Idempotency Stripe events

Table `stripe_webhook_events (event_id PK, processed_at)` — dedup avant publish bus.

### 3. Secrets runbook

Ajouter à Phase 2 runbook production :

- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- Stripe Connect onboarding studio

### 4. Tests

- `billing/webhook.test.ts` — étendre prod config guard
- E2E stripe-cli local documenté

## Critères d'acceptation

- [ ] Prod sans STRIPE_WEBHOOK_SECRET → deploy checklist fail
- [ ] Webhook 400/500 si signature invalid (existe) — jamais 200 sans traitement
- [ ] Event idempotency en DB
- [ ] `docs/runbooks/billing.md` complet

## Priorité

**P1** avant facturation active
