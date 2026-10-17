# Stripe production — provisioning (issue #122)

**Owner:** Backend / billing ops  
**Prerequis:** API deployee staging + production, migrations `0010_stripe_webhook_events.sql` et `0036_billing_runtime.sql` appliquees et verifiees, role `athlya_billing` en LOGIN (Phase 2).

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
   - `invoice.paid`, `invoice.finalized`, `invoice.updated`, `invoice.voided`,
     `invoice.marked_uncollectible`
   - `invoice.payment_failed`
4. Copier **Signing secret** (`whsec_...`) par environnement.
5. **API keys** : secret key `sk_test_...` / `sk_live_...` selon env.
6. **Product catalog** : produit « Athlya Pro » avec un prix recurrent ; copier le
   `price_...` (`STRIPE_PRICE_ID_PRO`).

Connect onboarding studio : voir [billing.md](./billing.md) § Connect.

---

## Phase 2 — Migration + role `athlya_billing` (Neon)

```powershell
$env:MIGRATION_DATABASE_URL = "postgresql://neondb_owner:...@..."
pnpm --filter @athlya/db run migrate
```

Verifier :

```sql
SELECT name FROM _athlya_migrations
 WHERE name IN ('0010_stripe_webhook_events.sql', '0036_billing_runtime.sql');  -- 2 lignes
\d stripe_webhook_events
\d studio_subscriptions
\d studio_invoices
SELECT has_function_privilege('athlya_billing', 'billing_apply_stripe_event(text, text, jsonb)', 'EXECUTE') AS billing_ok,
       NOT has_function_privilege('athlya_app', 'billing_apply_stripe_event(text, text, jsonb)', 'EXECUTE') AS app_refused,
       has_function_privilege('athlya_app', 'billing_list_invoices(uuid, timestamptz, uuid, integer)', 'EXECUTE') AS listing_ok;
-- 3 x true
```

La migration cree `athlya_billing` (NOLOGIN). Le webhook applique les
evenements Stripe sous ce role dedie — `athlya_app` ne peut pas les appliquer.
Le passer en LOGIN une fois par environnement, **apres** la migration (Neon,
role owner) :

```sql
ALTER ROLE athlya_billing LOGIN PASSWORD '<vault>';
```

Puis le contrat de roles (rejoue chaque charge sous son role, tout est annule) :

```powershell
$env:APP_DATABASE_URL = "postgresql://athlya_app:...@.../athlya"
$env:CRON_DATABASE_URL = "postgresql://athlya_cron:...@.../athlya"
$env:BILLING_DATABASE_URL = "postgresql://athlya_billing:...@.../athlya"
$env:SMOKE_STUDIO_SLUG = "<studio existant>"
node scripts/verify-role-contract.mjs
```

---

## Phase 3 — Secrets Cloudflare Workers

`/v1/billing/*` est servi par le Worker **billing** (`wrangler.billing.toml`,
issue #230), un Worker distinct : il n'herite **d'aucun** secret du gateway.
Il lui faut ses propres secrets runtime en plus de ceux de Stripe :

| Secret (Worker billing)                 | Requis     | Usage                                        |
| --------------------------------------- | ---------- | -------------------------------------------- |
| `DB_URL`                                | oui        | `athlya_app` : checkout, factures, audit     |
| `BILLING_DB_URL`                        | oui        | `athlya_billing` : application des webhooks  |
| `REDIS_URL`, `REDIS_TOKEN`              | oui        | rate limit, idempotence                      |
| `JWT_JWKS_URL`                          | oui        | verification des JWT admin                   |
| `JWT_KID`, `JWT_*_KEY_PEM`, `JWKS_JSON` | oui        | rotation JWT (`/admin/*`)                    |
| `CF_ACCESS_AUD`, `CF_ACCESS_CERTS_URL`  | prod       | Cloudflare Access sur `/admin/*`             |
| `CORS_ORIGIN`                           | oui        | origines du studio app                       |
| `STRIPE_*`, `BILLING_REDIRECT_URL`      | oui        | checkout + signature webhook                 |
| `SENTRY_DSN`, `OTEL_EXPORTER_OTLP_*`    | prod       | observabilite (memes valeurs que le gateway) |
| `JWT_ISSUER`, `JWT_AUDIENCE`            | si gateway | memes valeurs que le gateway                 |

Le gateway (`wrangler.toml`) garde une copie des secrets Stripe pour le
fallback `*.workers.dev`. `scripts/verify-secrets.mjs` (staging gate et
`deploy-production.yml`) exige ces secrets sur les deux Workers, plus
`CF_ACCESS_AUD` / `CF_ACCESS_CERTS_URL` en production sur le billing Worker
(il sert `/admin/*`).

```powershell
cd packages/api

foreach ($envName in 'staging', 'production') {
  # Worker billing (routes /v1/billing/*) — runtime partage avec le gateway
  foreach ($name in 'DB_URL', 'REDIS_URL', 'REDIS_TOKEN', 'JWT_JWKS_URL', 'CORS_ORIGIN',
                    'JWT_KID', 'JWT_PRIVATE_KEY_PEM', 'JWT_PUBLIC_KEY_PEM', 'JWKS_JSON',
                    'SENTRY_DSN', 'OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_HEADERS') {
    pnpm exec wrangler secret put $name --config wrangler.billing.toml --env $envName
  }
  # Worker billing — Stripe
  pnpm exec wrangler secret put STRIPE_SECRET_KEY --config wrangler.billing.toml --env $envName
  pnpm exec wrangler secret put STRIPE_WEBHOOK_SECRET --config wrangler.billing.toml --env $envName
  pnpm exec wrangler secret put STRIPE_PRICE_ID_PRO --config wrangler.billing.toml --env $envName
  pnpm exec wrangler secret put BILLING_REDIRECT_URL --config wrangler.billing.toml --env $envName   # https://<studio app origin>
  pnpm exec wrangler secret put BILLING_DB_URL --config wrangler.billing.toml --env $envName         # postgresql://athlya_billing:...

  # Gateway (fallback *.workers.dev)
  pnpm exec wrangler secret put STRIPE_SECRET_KEY --env $envName
  pnpm exec wrangler secret put STRIPE_WEBHOOK_SECRET --env $envName
  pnpm exec wrangler secret put STRIPE_PRICE_ID_PRO --env $envName
  pnpm exec wrangler secret put BILLING_REDIRECT_URL --env $envName
  pnpm exec wrangler secret put BILLING_DB_URL --env $envName

  pnpm exec wrangler deploy --config wrangler.billing.toml --env $envName
  pnpm exec wrangler deploy --env $envName
}
```

Ne jamais committer les cles. Stocker dans le vault ops.

Sans `BILLING_DB_URL` (hors `dev`, qui retombe sur `DB_URL`), un webhook signe
repond **500** : Stripe relivre l'evenement jusqu'a ce que le secret soit pose,
rien n'est perdu.

Sans `STRIPE_SECRET_KEY` + `STRIPE_PRICE_ID_PRO` + une origine de redirection
`https://` (`BILLING_REDIRECT_URL`, sinon `WEB_APP_URL`), `POST /v1/billing/checkout`
reste en 503 `billing_not_configured` (toujours en `dev`).

## Fonctionnement (issue #122)

- **Checkout** : session Stripe en mode `subscription` sur le compte plateforme,
  `client_reference_id` = studio, `metadata` + `subscription_data.metadata` =
  `{ studioId, userId }` (admin initiateur), `Idempotency-Key` par requete. L'URL
  renvoyee est refusee si elle n'est pas `https://checkout.stripe.com/...`.
- **Webhook** : apres verification de signature, **une seule instruction SQL**
  (`billing_apply_stripe_event`) reclame l'evenement Stripe, met a jour
  `studio_subscriptions` / `studio_invoices`, ecrit l'evenement bus dans l'outbox
  (`billing.subscription.started` a la creation de l'abonnement,
  `billing.subscription.failed` sur `invoice.payment_failed`) et la ligne d'audit.
  Un echec annule aussi la reclamation : la relance Stripe est retraitee au lieu
  d'etre ignoree comme doublon. Un rejeu est un no-op.
- **Ordre de livraison** : Stripe n'ordonne pas ses envois. Une facture porte
  le snapshot des metadata de l'abonnement (`studioId`, `userId`) : elle est
  rattachee au studio meme si elle arrive avant l'abonnement. Sans metadata ni
  abonnement connu (abonnement hors Athlya, ou studio supprime), l'evenement est
  acquitte sans effet. Un evenement plus ancien livre
  en retard (`created` Stripe) ne fait jamais reculer un statut (une facture
  `paid` ne redevient pas `open`).
- **Factures** : `GET /v1/billing/invoices` (admin) pagine `studio_invoices`
  (curseur opaque `created_at|id`) sous les claims du tenant : la RLS limite la
  lecture aux admins du studio.

---

## Phase 4 — Validation

### E2E test mode (staging)

1. Admin studio : `POST /v1/billing/checkout {"plan":"pro"}` → `checkoutUrl`
   `https://checkout.stripe.com/...` ; payer avec `4242 4242 4242 4242`.
2. Verifier :
   ```sql
   SELECT status, current_period_end, initiated_by FROM studio_subscriptions WHERE studio_id = '<studio>';
   SELECT stripe_invoice_id, status, amount_due FROM studio_invoices WHERE studio_id = '<studio>';
   SELECT event_type, published_at FROM outbox WHERE event_type LIKE 'billing.%' ORDER BY occurred_at DESC LIMIT 5;
   ```
3. Rejeu : Dashboard → Webhooks → evenement → **Resend** → reponse 200, aucune
   nouvelle ligne (`stripe_webhook_events` inchange, pas de second evenement outbox).
4. Echec sur **l'abonnement cree a l'etape 1** (un `stripe trigger` generique cree
   un client et un abonnement sans metadata Athlya, qui ne touchent aucun studio) :
   ```bash
   # carte qui s'attache puis echoue au debit
   stripe payment_methods attach pm_card_chargeCustomerFail --customer <cus_...>
   stripe subscriptions update <sub_...> \
     -d default_payment_method=pm_card_chargeCustomerFail \
     -d billing_cycle_anchor=now -d proration_behavior=none
   ```
   Le changement d'ancre facture immediatement l'abonnement → `invoice.payment_failed`
   pour ce `sub_...` → facture `open` dans `studio_invoices` du studio +
   `billing.subscription.failed` dans l'outbox → email de relance a l'admin initiateur.
5. `GET /v1/billing/invoices` (admin) liste la facture ; un membre recoit 403.

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
| Migration 0036 + rôle      | [ ]     | [ ]        | `athlya_billing` LOGIN + `BILLING_DB_URL` (Phase 2/3)     |
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

1. Desactiver webhook dans Stripe Dashboard (pause deliveries) — Stripe garde les
   evenements et les relivre a la reactivation (retries jusqu'a 3 jours).
2. Retirer `STRIPE_PRICE_ID_PRO` pour couper le checkout (503) sans toucher aux
   webhooks, ou retirer `STRIPE_WEBHOOK_SECRET` pour le fail-closed 500.
3. `wrangler rollback` vers la version precedente si regression de code ; la
   migration `0036` est additive et peut rester en place.
4. Rattrapage : reactiver le webhook, puis **Resend** des evenements manques ; les
   rejeux deja appliques sont des no-op.

---

## References

- `packages/api/src/routes/billing.ts`
- `packages/billing/src/webhook.ts`
- `docs/runbooks/billing.md`
- Issues #69, #122
