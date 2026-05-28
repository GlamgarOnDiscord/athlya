# Runbook — Stripe billing (issue #69)

Provisioning production : **[stripe-production.md](./stripe-production.md)** (issue #122).

## Secrets (staging + production)

```bash
pnpm --filter @athlya/api exec wrangler secret put STRIPE_SECRET_KEY --env staging
pnpm --filter @athlya/api exec wrangler secret put STRIPE_WEBHOOK_SECRET --env staging
pnpm --filter @athlya/api exec wrangler secret put STRIPE_SECRET_KEY --env production
pnpm --filter @athlya/api exec wrangler secret put STRIPE_WEBHOOK_SECRET --env production
```

Deploy checklist : **refuser prod** si `STRIPE_WEBHOOK_SECRET` absent (`POST /v1/billing/webhook` → 500 `configuration_error` hors `dev`).

## Webhook endpoint

- URL : `https://api.athlya.app/v1/billing/webhook` (staging : `staging.api.athlya.app`)
- Auth : header `Stripe-Signature` uniquement (pas de JWT)
- Body : raw bytes (`c.req.raw.text()`) — ne pas re-parser via middleware JSON

## Idempotency (DB)

Table `stripe_webhook_events` (`event_id` PK). Premier delivery → insert + publish (quand bus câblé). Retry Stripe même `event.id` → 200 sans re-publish.

Migration : `packages/db/migrations/0010_stripe_webhook_events.sql`

## Local test (stripe-cli)

```bash
stripe listen --forward-to http://localhost:8787/v1/billing/webhook
stripe trigger checkout.session.completed
```

Exporter le `whsec_…` dans `STRIPE_WEBHOOK_SECRET` pour `wrangler dev`.

## Mode dégradé

| Env | `STRIPE_*` absent | Comportement |
|-----|-------------------|--------------|
| `dev` | oui | webhook 200 no-op (logs warn) |
| `staging` / `production` | oui | webhook **500** |
| * | checkout 503 `billing_not_configured` | |

## Connect / onboarding studio

Stripe Connect onboarding par studio : hors scope ce runbook — suivre doc Stripe Connect + variables studio dans dashboard.
